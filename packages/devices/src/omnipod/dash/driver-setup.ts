/**
 * Pod lifecycle of the Omnipod DASH driver: pair, prime, insert cannula, deactivate. Port of
 * `pairAndPrime`, `insertCannula`, `deactivatePod` of `PumpManager/OmniPumpManager.swift` and of
 * `blePairAndSetupPod`, `pairPod`, `setupPod` of `Bluetooth/BlePodComms.swift` and `prime`,
 * `programInitialBasalSchedule`, `insertCannula`, `deactivatePod` of `PodCommsSession.swift`
 * (OmnipodKit, MIT License, (c) LoopKit Authors).
 *
 * BENCH USE ONLY: the pod is filled with water and never attached to a body.
 */
import type { Millis, Schedule } from '@buddy/core';
import { hex } from '@buddy/core';
import {
  CancelDeliveryType,
  POD,
  PodModel,
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
  type VersionResponseBlock,
} from '../common';
import { randomBytes } from '../common/bytes';
import { DASH_TOP_ID_BYTE } from './constants';
import { PodComms, DASH_ZERO_BASAL_RATE } from './comms';
import { OmnipodDashCore } from './driver-core';
import { accountUnresolvedPending, endBasalSegment, finishBolus, resumeDelivery, emptyLedger, type LedgerState } from './dose-ledger';
import { describePending } from './pending';
import { errorMessage, OmnipodError } from './errors';
import type { PodLink } from './link';
import { negotiateLtk } from './ltk-exchanger';
import { initialRecord, clearRecord } from './record';
import { findPairablePod } from './scan';
import { negotiateSessionKeys } from './session-establisher';

export type FlowResult = { readonly ok: true } | { readonly ok: false; readonly error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export type PodPhase = 'none' | 'pairing' | 'priming' | 'readyToInsert' | 'inserting' | 'running' | 'faulted';

export interface OmnipodPodStatus {
  readonly connected: boolean;
  readonly setupProgress: SetupProgress;
  readonly phase: PodPhase;
  readonly podProgress: PodProgress | null;
  readonly podProgressName: string;
  readonly reservoirUnits: number | null;
  /** The pod only reports "more than 50 U" above that. */
  readonly reservoirAbove50: boolean;
  readonly activatedAt: Millis | null;
  /** nominal end of life: activation + 72 h (the pod keeps delivering until 80 h) */
  readonly expiresAt: Millis | null;
  readonly primeFinishAt: Millis | null;
  readonly fault: string | null;
  readonly firmwareVersion: string;
  readonly lot: number;
  readonly tid: number;
  readonly lastSync: Millis;
}

/** `createDashControllerId`: top byte 0x17, 20 random bits, low two bits free for pod ids. */
function newControllerId(): number {
  const r = randomBytes(4);
  const bits = ((r[0]! << 16) | (r[1]! << 8) | r[2]!) & 0x3fffff;
  return ((DASH_TOP_ID_BYTE << 24) | (bits << 2)) >>> 0;
}

export class OmnipodDashSetup extends OmnipodDashCore {
  /** Current pod status from the last sync (no BLE traffic). */
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
    else if (r.ltk) phase = 'pairing';
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
      if (!this.isConnected) {
        await this.ensureConnected(); // the connect itself syncs
        return { ok: true } as const;
      }
      await this.refreshStatus();
      return { ok: true } as const;
    });
  }

  private async flow(name: string, fn: () => Promise<FlowResult>): Promise<FlowResult> {
    return this.serialize(async () => {
      try {
        return await fn();
      } catch (e) {
        this.log.error(`Omnipod DASH ${name}: ${errorMessage(e)}`);
        return fail(`${name}: ${errorMessage(e)}`);
      }
    });
  }

  // ── pair and prime ──────────────────────────────────────────────────────────

  /** Finds and pairs the pod, sets it up and starts priming. Poll {@link refreshPod} afterwards. */
  pairAndPrime(): Promise<FlowResult> {
    return this.flow('pairAndPrime', async () => {
      await this.load();
      const sp = this.record.setupProgress;
      if (sp === SetupProgress.activationTimeout || sp === SetupProgress.podIncompatible) return fail('The pod cannot be used any more. Discard it and start with a new one.');
      if (this.record.fault) return fail(`The pod faulted (${this.record.fault.description}). Deactivate or discard it.`);
      if (sp !== SetupProgress.none) await this.ensureConnected();
      else if (this.record.ltk && this.record.bleId) await this.resumePairing();
      else await this.pairPod();
      await this.prime();
      return { ok: true } as const;
    });
  }

  private async pairPod(): Promise<void> {
    const ad = await findPairablePod(this.ble, this.opts.scanTimeoutMs);
    const controllerId = this.record.controllerId || newControllerId();
    const podId = (controllerId + 1) >>> 0;
    const link = await this.openLink(ad.id, controllerId);
    try {
      const pair = await negotiateLtk(link, { myId: controllerId, podId });
      // The LTK is the one thing that cannot be recreated: store it before anything else.
      this.update({ ltk: hex(pair.ltk), controllerId, podId, bleId: ad.id, setupProgress: SetupProgress.none, transport: { ...this.record.transport, eapSeq: 1 } });
      await this.persist();

      const session = await negotiateSessionKeys(link, { ltk: pair.ltk, eapSqn: 1, myId: controllerId, podId, msgSeq: pair.msgSeq });
      if (session.kind !== 'keys') throw new OmnipodError('session', 'The pod asked for a resynchronisation right after pairing');
      const transport = this.makeTransport(link, { ck: hex(session.ck), noncePrefix: hex(session.noncePrefix), eapSeq: 1, msgSeq: session.msgSeq, nonceSeq: 0, messageNumber: 0 });
      await this.finishSetup(link, new PodComms(transport, podId));
    } catch (e) {
      await link.close();
      throw e;
    }
  }

  /**
   * The link broke after the pairing keys were exchanged but before the pod was set up: the pod
   * no longer advertises as pairable, so continue with the stored keys on a fresh session.
   */
  private async resumePairing(): Promise<void> {
    const r = this.record;
    const link = await this.openLink(r.bleId!, r.controllerId);
    try {
      const transport = await this.establishSession(link, r);
      await this.finishSetup(link, new PodComms(transport, r.podId));
    } catch (e) {
      await link.close();
      throw e;
    }
  }

  /** `AssignAddress` and `SetupPod`: the pod gets its address and the time, and reports its parameters. */
  private async finishSetup(link: PodLink, comms: PodComms): Promise<void> {
    const podId = this.record.podId;
    const assigned = await comms.assignAddress();
    this.update({ lot: assigned.lot, tid: assigned.tid, firmwareVersion: assigned.firmwareVersion, iFirmwareVersion: assigned.iFirmwareVersion, podModel: assigned.podModel });
    const now = this.now();
    const setup = await comms.setupPod({ address: podId, lot: assigned.lot, tid: assigned.tid, date: this.localDate(now) });
    this.checkCompatible(setup);
    if (setup.podProgress === PodProgress.activationTimeExceeded) {
      this.update({ setupProgress: SetupProgress.activationTimeout });
      await this.persist();
      throw new OmnipodError('incompatible', 'Activation time exceeded');
    }
    this.update({
      setupProgress: SetupProgress.podPaired,
      activatedAt: now,
      firmwareVersion: setup.firmwareVersion,
      iFirmwareVersion: setup.iFirmwareVersion,
      utcOffsetSeconds: this.opts.utcOffsetSeconds(now),
      lastSync: now,
    });
    await this.persist();
    this.adoptLink(link, comms);
  }

  /** Date components of `at` in the local time zone (`SetupPodCommand.dateComponents`). */
  protected localDate(at: Millis) {
    const d = new Date(at + this.opts.utcOffsetSeconds(at) * 1000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }

  private checkCompatible(v: VersionResponseBlock): void {
    const problems: string[] = [];
    const s = v.setup;
    if (v.podModel !== PodModel.dash) problems.push(`Pod reported product id ${v.podModel}, expected ${PodModel.dash} (DASH)`);
    if (!s) problems.push('Pod did not report its delivery parameters');
    else {
      if (s.pulseSize !== POD.pulseSize) problems.push(`Pod reported a pulse size of ${s.pulseSize} U instead of ${POD.pulseSize} U`);
      if (s.secondsPerBolusPulse !== POD.secondsPerBolusPulse) problems.push(`Pod reported ${s.secondsPerBolusPulse} s per bolus pulse instead of ${POD.secondsPerBolusPulse} s`);
      if (s.secondsPerPrimePulse !== POD.secondsPerPrimePulse) problems.push(`Pod reported ${s.secondsPerPrimePulse} s per prime pulse instead of ${POD.secondsPerPrimePulse} s`);
      if (s.primeUnits !== POD.primeUnits) problems.push(`Pod reported a prime bolus of ${s.primeUnits} U instead of ${POD.primeUnits} U`);
      if (s.cannulaInsertionUnits !== POD.cannulaInsertionUnits) problems.push(`Pod reported a cannula insertion bolus of ${s.cannulaInsertionUnits} U instead of ${POD.cannulaInsertionUnits} U`);
      if (s.serviceDuration < POD.serviceDuration) problems.push(`Pod reported a service duration of ${s.serviceDuration / 3600} h, shorter than ${POD.serviceDuration / 3600} h`);
    }
    if (problems.length) {
      this.update({ setupProgress: SetupProgress.podIncompatible });
      throw new OmnipodError('incompatible', problems.join('. '));
    }
  }

  /** `PodCommsSession.prime`. */
  private async prime(): Promise<void> {
    const comms = this.comms!;
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
    const finishAt = this.now() + primeMs;
    this.update({ setupProgress: SetupProgress.startingPrime, primeFinishAt: finishAt });
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
        basal = basalScheduleFromBuddy(schedule, DASH_ZERO_BASAL_RATE);
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
    const at = this.now();
    const l = this.record.ledger;
    if (l.pending) this.log.warn(`Omnipod DASH: resetting the pod with the ${describePending(l.pending)} unresolved, accounting for it`);
    let ended: LedgerState = accountUnresolvedPending(l, at);
    if (ended.bolus) ended = finishBolus(ended, ended.bolus.delivered);
    ended = resumeDelivery(endBasalSegment(ended, at), at);
    this.dropConnection();
    this.record = { ...initialRecord(), ledger: { ...emptyLedger(), doses: ended.doses } };
    await clearRecord(this.secrets);
    await this.persist();
  }
}
