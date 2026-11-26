/**
 * Pod lifecycle of the Omnipod Eros driver: pair, prime, insert cannula, deactivate. Port of
 * `pairAndPrime`, `insertCannula`, `deactivatePod` of `PumpManager/OmniPumpManager.swift` and
 * `prime`, `programInitialBasalSchedule`, `insertCannula`, `deactivatePod` of
 * `PodCommsSession.swift` (OmnipodKit, MIT License, (c) LoopKit Authors). Pairing itself is in
 * `pairing.ts`.
 *
 * BENCH USE ONLY: the pod is filled with water and never attached to a body.
 */
import type { Millis, Schedule } from '@buddy/core';
import {
  CancelDeliveryType,
  POD,
  PodProgress,
  SetupProgress,
  basalScheduleFromBuddy,
  deliveryIsSuspended,
  expiredAlert,
  expirationReminderAlert,
  finishSetupReminderAlert,
  lowReservoirAlert,
  podProgressName,
  podProgressReadyForDelivery,
  reservoirUnitsOf,
  setupNeedsInitialBasal,
  shutdownImminentAlert,
  type AlertConfiguration,
  type PodStatusSnapshot,
} from '../common';
import { accountUnresolvedPending, emptyLedger, endBasalSegment, finishBolus, resumeDelivery, type LedgerState } from '../dash/dose-ledger';
import { describePending } from '../dash/pending';
import type { FlowResult, OmnipodPodStatus, PodPhase } from '../dash/driver-setup';
import { EROS_ZERO_BASAL_RATE } from './comms';
import { errorMessage, OmnipodError } from './errors';
import { OmnipodErosPairing } from './pairing';
import { clearErosRecord, initialErosRecord } from './record';

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export class OmnipodErosSetup extends OmnipodErosPairing {
  /** Current pod status from the last sync (no radio traffic). */
  async podStatus(): Promise<OmnipodPodStatus> {
    await this.load();
    const r = this.record;
    const st: PodStatusSnapshot | null = r.lastStatus;
    const sp = r.setupProgress;
    let phase: PodPhase = 'none';
    if (r.fault) phase = 'faulted';
    else if (sp === SetupProgress.completed) phase = 'running';
    else if (sp === SetupProgress.startingInsertCannula || sp === SetupProgress.cannulaInserting) phase = 'inserting';
    else if (sp === SetupProgress.initialBasalScheduleSet || sp === SetupProgress.settingInitialBasalSchedule) phase = 'readyToInsert';
    else if (sp === SetupProgress.priming || sp === SetupProgress.startingPrime || sp === SetupProgress.podPaired) phase = 'priming';
    else if (r.podId !== 0) phase = 'pairing';
    return {
      connected: this.isConnected,
      setupProgress: sp,
      phase,
      podProgress: st?.podProgress ?? null,
      podProgressName: st ? podProgressName(st.podProgress) : 'none',
      reservoirUnits: st ? reservoirUnitsOf(st) : null,
      reservoirAbove50: st !== null && reservoirUnitsOf(st) === null,
      activatedAt: r.activatedAt,
      expiresAt: r.activatedAt === null ? null : r.activatedAt + POD.nominalPodLife * 1000,
      primeFinishAt: r.primeFinishAt,
      fault: r.fault?.description ?? null,
      firmwareVersion: r.firmwareVersion,
      lot: r.lot,
      tid: r.tid,
      lastSync: r.lastSync,
    };
  }

  /** Connects if needed and syncs the pod status (also during setup). */
  refreshPod(): Promise<FlowResult> {
    return this.flow('refreshPod', async () => {
      await this.load();
      if (!this.hasPairedPod) return fail('No pod is paired');
      if (!this.isConnected) await this.ensureConnected(); // the connect itself syncs
      else await this.refreshStatus();
      return { ok: true } as const;
    });
  }

  private async flow(name: string, fn: () => Promise<FlowResult>): Promise<FlowResult> {
    return this.serialize(async () => {
      try {
        return await fn();
      } catch (e) {
        this.log.error(`Omnipod Eros ${name}: ${errorMessage(e)}`);
        return fail(`${name}: ${errorMessage(e)}`);
      }
    });
  }

  // ── pair and prime ──────────────────────────────────────────────────────────

  /** Pairs the pod (address and setup), then starts priming. Poll {@link refreshPod} afterwards. */
  pairAndPrime(): Promise<FlowResult> {
    return this.flow('pairAndPrime', async () => {
      await this.load();
      const sp = this.record.setupProgress;
      if (sp === SetupProgress.activationTimeout || sp === SetupProgress.podIncompatible) return fail('The pod cannot be used any more. Discard it and start with a new one.');
      if (this.record.fault) return fail(`The pod faulted (${this.record.fault.description}). Deactivate or discard it.`);
      if (sp === SetupProgress.none) await this.assignAddressAndSetup();
      else await this.ensureConnected();
      await this.prime();
      return { ok: true } as const;
    });
  }

  /** `PodCommsSession.prime`. */
  private async prime(): Promise<void> {
    const comms = this.comms;
    if (!comms) throw new OmnipodError('notConnected', 'Pod not connected');
    const primeMs = (POD.primeUnits / POD.primeDeliveryRate) * 1000 + 3000;
    if (this.record.setupProgress === SetupProgress.podPaired) {
      await comms.faultConfig();
      await comms.configureAlerts([finishSetupReminderAlert()]);
    } else if (this.record.setupProgress === SetupProgress.startingPrime || this.record.setupProgress === SetupProgress.priming) {
      const status = await comms.getStatus();
      await this.applyStatus(status);
      if (status.podProgress === PodProgress.priming || status.podProgress === PodProgress.primingCompleted) {
        this.update({ setupProgress: SetupProgress.priming });
        await this.persist();
        return;
      }
    }
    this.update({ setupProgress: SetupProgress.startingPrime, primeFinishAt: this.now() + primeMs });
    await this.persist();
    const status = await comms.setupBolus(POD.primeUnits);
    this.update({ setupProgress: SetupProgress.priming });
    await this.applyStatus(status);
  }

  // ── cannula ─────────────────────────────────────────────────────────────────

  /**
   * Programs the basal schedule and starts the cannula insertion bolus (the pod must be primed).
   * Bench: no cannula is ever inserted into anyone; the pod only runs the motor. Poll
   * {@link refreshPod} until the setup progress is `completed`.
   */
  insertCannula(schedule: Schedule): Promise<FlowResult> {
    return this.flow('insertCannula', async () => {
      await this.load();
      const r = this.record;
      if (!this.hasPairedPod || r.activatedAt === null) return fail('No pod is paired');
      if (r.fault) return fail(`The pod faulted (${r.fault.description})`);
      const sp = r.setupProgress;
      const ready: SetupProgress[] = [SetupProgress.priming, SetupProgress.settingInitialBasalSchedule, SetupProgress.initialBasalScheduleSet, SetupProgress.startingInsertCannula, SetupProgress.cannulaInserting];
      if (sp === SetupProgress.completed) return { ok: true } as const;
      if (!ready.includes(sp)) return fail(`The pod is not ready for the cannula insertion (${sp})`);
      let basal;
      try {
        basal = basalScheduleFromBuddy(schedule, EROS_ZERO_BASAL_RATE);
      } catch (e) {
        return fail(errorMessage(e));
      }
      const comms = await this.ensureConnected();

      if (setupNeedsInitialBasal(this.record.setupProgress)) {
        let programmed = false;
        if (this.record.setupProgress === SetupProgress.settingInitialBasalSchedule) {
          // an earlier attempt may have gone through without us seeing the answer
          const status = await comms.getStatus();
          await this.applyStatus(status);
          programmed = status.podProgress === PodProgress.basalInitialized;
        }
        if (!programmed) {
          this.update({ setupProgress: SetupProgress.settingInitialBasalSchedule });
          await this.persist();
          const now = this.now();
          const status = await comms.setBasalSchedule(basal, this.scheduleOffsetSeconds(now));
          this.update({ utcOffsetSeconds: this.opts.utcOffsetSeconds(now) });
          await this.applyStatus(status);
        }
        this.update({ setupProgress: SetupProgress.initialBasalScheduleSet, basalSchedule: schedule });
        await this.persist();
      }

      const cur = this.record.setupProgress;
      if (cur === SetupProgress.startingInsertCannula || cur === SetupProgress.cannulaInserting) {
        const status = await comms.getStatus();
        await this.applyStatus(status);
        if (status.podProgress === PodProgress.insertingCannula) {
          this.update({ setupProgress: SetupProgress.cannulaInserting });
          await this.persist();
          return { ok: true } as const;
        }
        if (podProgressReadyForDelivery(status.podProgress)) return { ok: true } as const;
      } else {
        await comms.configureAlerts(this.podAlerts());
      }
      this.update({ setupProgress: SetupProgress.startingInsertCannula });
      await this.persist();
      const status = await comms.setupBolus(POD.cannulaInsertionUnits);
      this.update({ setupProgress: SetupProgress.cannulaInserting });
      await this.applyStatus(status);
      return { ok: true } as const;
    });
  }

  /** Alerts configured when the cannula insertion starts (`PumpManager.insertCannula`). */
  private podAlerts(): AlertConfiguration[] {
    const st = this.record.lastStatus;
    const podTime = st ? st.timeActive + Math.max(0, (this.now() - st.receivedAt) / 1000) : 0;
    const silent = this.settings.silentAlerts;
    const alerts: AlertConfiguration[] = [
      expiredAlert(podTime, POD.nominalPodLife, POD.expirationAdvisoryWindow, silent),
      shutdownImminentAlert(podTime, POD.serviceDuration - POD.endOfServiceImminentWindow, silent),
    ];
    if (this.settings.expirationReminderHours > 0) alerts.push(expirationReminderAlert(podTime, POD.nominalPodLife - this.settings.expirationReminderHours * 3600, silent));
    if (this.settings.lowReservoirUnits > 0) alerts.push(lowReservoirAlert(this.settings.lowReservoirUnits, silent));
    return alerts;
  }

  // ── end of life ─────────────────────────────────────────────────────────────

  /** Stops delivery and deactivates the pod. The pod record is cleared on success (history is kept). */
  deactivate(): Promise<FlowResult> {
    return this.flow('deactivatePod', async () => {
      await this.load();
      if (!this.hasPairedPod) {
        await this.resetPod();
        return { ok: true } as const;
      }
      const comms = await this.ensureConnected();
      if (this.setupComplete && !this.record.fault) {
        const st = this.record.lastStatus;
        if (!st || !deliveryIsSuspended(st.deliveryStatus)) {
          const status = await comms.cancelDelivery(CancelDeliveryType.all);
          await this.applyStatus(status);
        }
      }
      try {
        await comms.deactivate();
      } catch (e) {
        // OmnipodKit tolerates a fault or an unexpected answer here: the pod is shutting down
        if (!(e instanceof OmnipodError && (e.kind === 'podFault' || e.kind === 'protocol'))) throw e;
      }
      await this.resetPod();
      return { ok: true } as const;
    });
  }

  /** Forgets the pod without talking to it (unreachable, faulted beyond repair). History is kept. */
  discard(): Promise<FlowResult> {
    return this.flow('discardPod', async () => {
      await this.load();
      await this.resetPod();
      return { ok: true } as const;
    });
  }

  /** Clears the pod record but keeps what was delivered, so IOB stays right after the pod change. */
  private async resetPod(): Promise<void> {
    const at: Millis = this.now();
    const l = this.record.ledger;
    if (l.pending) this.log.warn(`Omnipod Eros: resetting the pod with the ${describePending(l.pending)} unresolved, accounting for it`);
    let ended: LedgerState = accountUnresolvedPending(l, at);
    if (ended.bolus) ended = finishBolus(ended, ended.bolus.delivered);
    ended = resumeDelivery(endBasalSegment(ended, at), at);
    this.dropConnection();
    this.record = { ...initialErosRecord(), ledger: { ...emptyLedger(), doses: ended.doses } };
    await clearErosRecord(this.secrets);
    await this.persist();
  }
}
