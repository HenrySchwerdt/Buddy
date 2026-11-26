/**
 * Status bookkeeping of the Omnipod Eros driver: reconciles the pod record and the dose ledger
 * with what the pod reports. Port of `PodState.updateFromStatusResponse` and
 * `PodCommsSession.recoverUnacknowledgedCommand` / `handlePodFault` of OmnipodKit (MIT License,
 * (c) LoopKit Authors). Same rules as the DASH driver: history only holds what the pod confirmed
 * as delivered, and an unacknowledged command is settled by the pod's last programming message
 * number.
 */
import type { Millis, PumpState } from '@buddy/core';
import {
  CancelDeliveryType,
  DeliveryStatus,
  PodProgress,
  SetupProgress,
  deliveredOfBolus,
  deliveryIsBolusing,
  deliveryIsSuspended,
  deliveryIsTempBasalRunning,
  faultFromDetailed,
  isFaulted,
  podProgressReadyForDelivery,
  reservoirUnitsOf,
  snapshotFromStatus,
  type PodFault,
  type StatusResponseBlock,
} from '../common';
import {
  accountUnresolvedPending,
  endBasalSegment,
  finishBolus,
  ledgerHistory,
  resumeDelivery,
  startBolus,
  startTempBasal,
  suspendDelivery,
  updateBolusFromPod,
  type LedgerState,
} from '../dash/dose-ledger';
import { describePending, resolvePending, type PendingOutcome } from '../dash/pending';
import type { ErosPodComms } from './comms';
import { OmnipodErosCore } from './driver-core';
import { errorMessage, OmnipodError } from './errors';

const MIN = 60_000;

export class OmnipodErosReconciler extends OmnipodErosCore {
  /** Outcome of the most recent resolution of an unacknowledged command. */
  protected lastPendingOutcome: PendingOutcome | null = null;

  // ── connection ─────────────────────────────────────────────────────────────

  /** Makes sure the RileyLink is connected and the pod is in sync. */
  protected async ensureConnected(): Promise<ErosPodComms> {
    await this.load();
    if (this.comms && this.device?.isConnected) return this.comms;
    this.comms = null;
    if (!this.hasPairedPod) throw new OmnipodError('invalid', 'No pod is paired');
    const device = await this.openRadio();
    const comms = this.makeComms(device);
    this.comms = comms;
    try {
      await this.refreshStatus();
    } catch (e) {
      if (!(e instanceof OmnipodError && e.kind === 'podFault')) {
        this.dropConnection();
        throw e;
      }
    }
    return comms;
  }

  /** Brings the record in line with the pod now (connects if needed). */
  protected async syncNow(): Promise<void> {
    if (this.isConnected) await this.refreshStatus();
    else await this.ensureConnected(); // the connect itself syncs
  }

  // ── status ─────────────────────────────────────────────────────────────────

  /** Asks the pod for its status and reconciles the record and dose ledger with it. */
  protected async refreshStatus(): Promise<StatusResponseBlock> {
    const comms = this.comms;
    if (!comms) throw new OmnipodError('notConnected', 'Pod not connected');
    let status: StatusResponseBlock;
    try {
      status = await comms.getStatus();
    } catch (e) {
      if (e instanceof OmnipodError && e.kind === 'podFault' && e.fault) await this.handleFault(e.fault);
      throw e;
    }
    await this.applyStatus(status);
    return status;
  }

  /** Records a pod fault: delivery has stopped. */
  protected async handleFault(fault: PodFault): Promise<void> {
    const at = this.now();
    if (!this.record.fault) this.log.error(`Omnipod Eros: pod fault ${fault.description}`);
    const last = this.record.lastStatus;
    this.update({
      fault: this.record.fault ?? fault,
      lastSync: at,
      lastStatus: last
        ? { ...last, receivedAt: at, podProgress: fault.podProgress, deliveryStatus: DeliveryStatus.suspended, bolusNotDelivered: fault.bolusNotDelivered, insulinDelivered: fault.totalInsulinDelivered }
        : last,
    });
    this.updateLedger((l) => {
      const p = l.pending;
      if (p) this.log.warn(`Omnipod Eros: pod fault with the ${describePending(p)}} unresolved, accounting for it`);
      let s = accountUnresolvedPending(l, at, p?.kind === 'bolus' ? deliveredOfBolus(p.units, fault.bolusNotDelivered) : undefined);
      if (s.bolus) s = finishBolus(s, deliveredOfBolus(s.bolus.requested, fault.bolusNotDelivered));
      return suspendDelivery(endBasalSegment(s, at), at);
    });
    await this.persist();
  }

  /**
   * Reconciles with a status the pod sent: resolves an unacknowledged command, brings the dose
   * ledger in line with what the pod reports, and advances the setup progress.
   */
  protected async applyStatus(status: StatusResponseBlock): Promise<void> {
    const at = this.now();
    this.update({ lastStatus: snapshotFromStatus(status, at), lastSync: at });

    const pending = this.record.ledger.pending;
    if (pending) {
      const outcome = resolvePending(pending, status);
      this.lastPendingOutcome = outcome;
      if (outcome === 'received') {
        this.log.info(`Omnipod Eros: the pod received the unacknowledged ${describePending(pending)}`);
        this.updateLedger((l) => ({ ...this.applyReceived(l, pending, status), pending: null }));
      } else if (outcome === 'notReceived') {
        this.log.warn(`Omnipod Eros: the pod did not receive the ${describePending(pending)}`);
        this.updateLedger((l) => ({ ...l, pending: null }));
      } else {
        this.log.warn(`Omnipod Eros: cannot tell whether the pod received the ${describePending(pending)}`);
      }
    }

    this.updateLedger((l) => this.reconcileDelivery(l, status, at));

    const sp = this.record.setupProgress;
    if ((sp === SetupProgress.cannulaInserting || sp === SetupProgress.startingInsertCannula) && podProgressReadyForDelivery(status.podProgress)) {
      this.update({ setupProgress: SetupProgress.completed, setupUnitsDelivered: status.insulinDelivered });
    }
    if (status.podProgress === PodProgress.faultEventOccurred || status.podProgress === PodProgress.activationTimeExceeded) {
      await this.persist();
      await this.readFault();
      return;
    }
    await this.persist();
  }

  /** The pod reported a fault progress: fetch the detailed status to learn which. */
  private async readFault(): Promise<void> {
    if (this.record.fault || !this.comms) return;
    try {
      const detailed = await this.comms.getDetailedStatus();
      if (isFaulted(detailed)) await this.handleFault(faultFromDetailed(detailed));
    } catch (e) {
      if (e instanceof OmnipodError && e.kind === 'podFault' && e.fault) await this.handleFault(e.fault);
      else this.log.warn(`Omnipod Eros: could not read the pod fault: ${errorMessage(e)}`);
    }
  }

  private applyReceived(l: LedgerState, p: NonNullable<LedgerState['pending']>, status: StatusResponseBlock): LedgerState {
    switch (p.kind) {
      case 'bolus':
        if (l.bolus?.id === p.id || l.doses.some((d) => d.id === p.id)) return l;
        return startBolus(l, { requested: p.units, automatic: p.automatic, at: p.sentAt, delivered: deliveredOfBolus(p.units, status.bolusNotDelivered), id: p.id });
      case 'tempBasal': {
        const started = startTempBasal(l, { rate: p.rate, durationMin: p.durationMin, at: p.sentAt });
        return deliveryIsTempBasalRunning(status.deliveryStatus) ? started : endBasalSegment(started, Math.min(this.now(), p.sentAt + p.durationMin * MIN));
      }
      case 'cancel': {
        let s = l;
        if (p.deliveryType & CancelDeliveryType.bolus && s.bolus) s = finishBolus(s, deliveredOfBolus(s.bolus.requested, status.bolusNotDelivered));
        if (p.deliveryType & CancelDeliveryType.basal) s = suspendDelivery(s, p.sentAt);
        else if (p.deliveryType & CancelDeliveryType.tempBasal) s = endBasalSegment(s, p.sentAt);
        return s;
      }
      case 'basalProgram':
        return resumeDelivery(l, p.sentAt);
    }
  }

  private reconcileDelivery(l: LedgerState, status: StatusResponseBlock, at: Millis): LedgerState {
    let s = l;
    const b = s.bolus;
    if (b) {
      const delivered = deliveredOfBolus(b.requested, status.bolusNotDelivered);
      s = deliveryIsBolusing(status.deliveryStatus) ? updateBolusFromPod(s, delivered, false) : finishBolus(s, Math.max(b.delivered, delivered));
    }
    if (!this.setupComplete) return s;
    const suspended = deliveryIsSuspended(status.deliveryStatus);
    if (suspended && s.basal.kind !== 'suspended') s = suspendDelivery(s, at);
    else if (!suspended && s.basal.kind === 'suspended') s = resumeDelivery(s, at);
    if (s.basal.kind === 'temp' && !deliveryIsTempBasalRunning(status.deliveryStatus)) {
      s = endBasalSegment(s, Math.min(at, s.basal.startedAt + s.basal.durationMin * MIN));
    }
    return s;
  }

  // ── PumpDriver-facing state ────────────────────────────────────────────────

  protected snapshotState(): PumpState {
    const r = this.record;
    const now = this.now();
    const st = r.lastStatus;
    const seg = r.ledger.basal;
    const tempRunning = seg.kind === 'temp' && now < seg.startedAt + seg.durationMin * MIN;
    return {
      reservoirUnits: st ? reservoirUnitsOf(st) : null,
      batteryPercent: null,
      suspended: !this.hasPairedPod || !this.setupComplete || seg.kind === 'suspended' || r.fault !== null || (this.setupComplete && st !== null && deliveryIsSuspended(st.deliveryStatus)),
      tempBasal: seg.kind === 'temp' && tempRunning ? { rate: seg.rate, startedAt: seg.startedAt, durationMin: seg.durationMin } : null,
      bolusing: r.ledger.bolus !== null || r.ledger.pending?.kind === 'bolus',
      bolusIncrement: 0.05,
      basalIncrement: 0.05,
      lastSync: r.lastSync,
    };
  }

  protected historyOf(since: Millis) {
    return ledgerHistory(this.record.ledger, since, this.now());
  }
}
