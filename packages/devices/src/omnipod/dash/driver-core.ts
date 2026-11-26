/**
 * Connection, persistence and status reconciliation of the Omnipod DASH driver. Port of the
 * session handling of `Bluetooth/BlePodComms.swift` (`establishNewSession`, reconnect) and the
 * status bookkeeping of `PumpManager/PodState.swift` (`updateFromStatusResponse`) and
 * `PodCommsSession.swift` (`recoverUnacknowledgedCommand`, `handlePodFault`) from OmnipodKit
 * (MIT License, (c) LoopKit Authors).
 *
 * Differences to the Swift original are marked DEVIATION. LoopKit glue, UI, alerts and
 * notifications are not ported (pod alerts are logged).
 */
import type { BleTransport, Clock, DeviceContext, Logger, Millis, PumpState, SecretStore } from '@buddy/core';
import { fromHex, hex } from '@buddy/core';
import {
  SetupProgress,
  deliveryIsBolusing,
  deliveryIsSuspended,
  deliveryIsTempBasalRunning,
  deliveredOfBolus,
  podProgressReadyForDelivery,
  reservoirUnitsOf,
  setupIsPaired,
  snapshotFromStatus,
  PodProgress,
  CancelDeliveryType,
  DeliveryStatus,
  faultFromDetailed,
  isFaulted,
  type PodFault,
  type StatusResponseBlock,
} from '../common';
import { PodComms } from './comms';
import { errorMessage, OmnipodError } from './errors';
import {
  accountUnresolvedPending,
  endBasalSegment,
  finishBolus,
  ledgerHistory,
  pruneLedger,
  resumeDelivery,
  startBolus,
  startTempBasal,
  suspendDelivery,
  updateBolusFromPod,
  type LedgerState,
} from './dose-ledger';
import { PodLink } from './link';
import { resolvePending, describePending, type PendingOutcome } from './pending';
import { loadRecord, saveRecord, type DashPodRecord, initialRecord } from './record';
import { negotiateSessionKeys } from './session-establisher';
import { PodMessageTransport, type TransportState } from './transport';

const MIN = 60_000;

export type OmnipodDashSettings = {
  /** Low reservoir alert of the pod in units (0 = off). */
  lowReservoirUnits: number;
  /** Hours before the 72 h nominal pod life at which the pod reminds (0 = off). */
  expirationReminderHours: number;
  /** Alerts without sound (the pod still raises them). */
  silentAlerts: boolean;
};

export interface OmnipodDriverOptions {
  /** Per BLE operation (write, CTS, data packet). */
  readonly ioTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly scanTimeoutMs?: number;
  /** Local UTC offset in seconds at `at`; used for the basal schedule and the pod clock. */
  readonly utcOffsetSeconds?: (at: Millis) => number;
  /** A status older than this is refreshed from the pod. */
  readonly statusFreshMs?: number;
}

export const DEFAULT_STATUS_FRESH_MS = 30_000;

export class OmnipodDashCore {
  protected readonly ble: BleTransport;
  protected readonly secrets: SecretStore;
  protected readonly clock: Clock;
  protected readonly log: Logger;
  protected readonly opts: Required<OmnipodDriverOptions>;

  protected record: DashPodRecord = initialRecord();
  private loading: Promise<void> | null = null;
  private link: PodLink | null = null;
  protected comms: PodComms | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  /** Outcome of the most recent resolution of an unacknowledged command (see `programCommand`). */
  protected lastPendingOutcome: PendingOutcome | null = null;

  constructor(
    protected readonly settings: OmnipodDashSettings,
    ctx: DeviceContext,
    options: OmnipodDriverOptions = {},
  ) {
    if (!ctx.ble) throw new Error('Omnipod DASH needs Bluetooth: DeviceContext.ble is missing');
    if (!ctx.secrets) throw new Error('Omnipod DASH needs secure storage for the pairing keys: DeviceContext.secrets is missing');
    this.ble = ctx.ble;
    this.secrets = ctx.secrets;
    this.clock = ctx.clock;
    this.log = ctx.log;
    this.opts = {
      ioTimeoutMs: options.ioTimeoutMs ?? 8_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      scanTimeoutMs: options.scanTimeoutMs ?? 12_000,
      utcOffsetSeconds: options.utcOffsetSeconds ?? ((at) => -new Date(at).getTimezoneOffset() * 60),
      statusFreshMs: options.statusFreshMs ?? DEFAULT_STATUS_FRESH_MS,
    };
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  /** One command in flight at a time. */
  protected serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  protected now(): Millis {
    return this.clock.now();
  }

  protected async load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        this.record = await loadRecord(this.secrets);
      })();
      this.loading.catch(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  protected update(patch: Partial<Omit<DashPodRecord, 'version'>>): void {
    this.record = { ...this.record, ...patch };
  }

  protected updateLedger(fn: (l: LedgerState) => LedgerState): void {
    this.record = { ...this.record, ledger: fn(this.record.ledger) };
  }

  /** Writes the record to the secret store; writes are queued in order. A failed write is logged, not thrown. */
  protected async persist(): Promise<void> {
    try {
      await this.persistStrict();
    } catch (e) {
      this.log.error(`Omnipod DASH: failed to persist the pod record: ${errorMessage(e)}`);
    }
  }

  /** Like {@link persist}, but rejects when the write failed (used where the record must be durable before acting). */
  protected persistStrict(): Promise<void> {
    const snapshot: DashPodRecord = { ...this.record, ledger: pruneLedger(this.record.ledger, this.now()) };
    const run = this.saving.then(() => saveRecord(this.secrets, snapshot));
    this.saving = run.catch(() => undefined);
    return run;
  }

  protected get isConnected(): boolean {
    return this.comms !== null && this.link?.isOpen === true;
  }

  protected get setupComplete(): boolean {
    return this.record.setupProgress === SetupProgress.completed;
  }

  protected get hasPairedPod(): boolean {
    return this.record.ltk !== null && this.record.bleId !== null && setupIsPaired(this.record.setupProgress);
  }

  protected dropConnection(): void {
    const l = this.link;
    this.link = null;
    this.comms = null;
    if (l) void l.close();
  }

  protected scheduleOffsetSeconds(at: Millis): number {
    const local = Math.floor(at / 1000) + this.opts.utcOffsetSeconds(at);
    return ((local % 86400) + 86400) % 86400;
  }

  // ── connection ─────────────────────────────────────────────────────────────

  /** Makes sure the pod is connected with an established session, and in sync. */
  protected async ensureConnected(): Promise<PodComms> {
    await this.load();
    if (this.comms && this.link?.isOpen) return this.comms;
    this.dropConnection();
    const r = this.record;
    if (!this.hasPairedPod || !r.ltk || !r.bleId) throw new OmnipodError('invalid', 'No pod is paired');
    const conn = await this.ble.connect(r.bleId, { timeoutMs: this.opts.connectTimeoutMs });
    const link = new PodLink(conn, { ioTimeoutMs: this.opts.ioTimeoutMs, log: this.log });
    try {
      await link.hello(r.controllerId);
      const transport = await this.establishSession(link, r);
      this.link = link;
      this.comms = new PodComms(transport, r.podId);
    } catch (e) {
      await link.close();
      throw e;
    }
    try {
      await this.refreshStatus();
    } catch (e) {
      if (!(e instanceof OmnipodError && e.kind === 'podFault')) {
        this.dropConnection();
        throw e;
      }
    }
    return this.comms!;
  }

  /** `establishNewSession`: EAP-AKA with the stored LTK; on a stale sequence number retry once. */
  protected async establishSession(link: PodLink, r: DashPodRecord): Promise<PodMessageTransport> {
    const ltk = fromHex(r.ltk!);
    let eapSeq = r.transport.eapSeq;
    for (let attempt = 0; attempt < 2; attempt++) {
      eapSeq += 1;
      const result = await negotiateSessionKeys(link, { ltk, eapSqn: eapSeq, myId: r.controllerId, podId: r.podId, msgSeq: 1 });
      if (result.kind === 'resync') {
        eapSeq = result.eapSqn;
        continue;
      }
      return this.makeTransport(link, {
        ck: hex(result.ck),
        noncePrefix: hex(result.noncePrefix),
        eapSeq,
        msgSeq: result.msgSeq,
        nonceSeq: 0,
        messageNumber: r.transport.messageNumber,
      });
    }
    this.update({ transport: { ...this.record.transport, eapSeq } });
    throw new OmnipodError('session', 'Received a resynchronisation request for the second time');
  }

  protected makeTransport(link: PodLink, state: TransportState): PodMessageTransport {
    this.update({ transport: state });
    return new PodMessageTransport(link, this.record.controllerId, this.record.podId, state, (s) => this.update({ transport: s }));
  }

  /** Opens the BLE link (hello, notifications) without a session: used while pairing. */
  protected async openLink(deviceId: string, controllerId: number): Promise<PodLink> {
    const conn = await this.ble.connect(deviceId, { timeoutMs: this.opts.connectTimeoutMs });
    const link = new PodLink(conn, { ioTimeoutMs: this.opts.ioTimeoutMs, log: this.log });
    try {
      await link.hello(controllerId);
    } catch (e) {
      await link.close();
      throw e;
    }
    return link;
  }

  protected adoptLink(link: PodLink, comms: PodComms): void {
    this.dropConnection();
    this.link = link;
    this.comms = comms;
  }

  // ── status ─────────────────────────────────────────────────────────────────

  /** Brings the record in line with the pod now (connects if needed). */
  protected async syncNow(): Promise<void> {
    if (this.isConnected) await this.refreshStatus();
    else await this.ensureConnected(); // the connect itself syncs
  }

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
    if (!this.record.fault) this.log.error(`Omnipod DASH: pod fault ${fault.description}`);
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
      if (p) this.log.warn(`Omnipod DASH: pod fault with the ${describePending(p)}} unresolved, accounting for it`);
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
        this.log.info(`Omnipod DASH: the pod received the unacknowledged ${describePending(pending)}`);
        this.updateLedger((l) => ({ ...this.applyReceived(l, pending, status), pending: null }));
      } else if (outcome === 'notReceived') {
        this.log.warn(`Omnipod DASH: the pod did not receive the ${describePending(pending)}`);
        this.updateLedger((l) => ({ ...l, pending: null }));
      } else {
        this.log.warn(`Omnipod DASH: cannot tell whether the pod received the ${describePending(pending)}`);
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
      else this.log.warn(`Omnipod DASH: could not read the pod fault: ${errorMessage(e)}`);
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
