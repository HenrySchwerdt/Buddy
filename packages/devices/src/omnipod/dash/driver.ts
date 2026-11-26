/**
 * The Omnipod DASH `PumpDriver`: the command side of `PumpManager/OmniPumpManager.swift`
 * (`enactBolus`, `cancelBolus`, `enactTempBasal`, `suspendDelivery`, `resumeDelivery`) on top of
 * the command layer of `PodCommsSession.swift`, from OmnipodKit (MIT License, (c) LoopKit
 * Authors), behind Buddy's `PumpDriver` contract.
 *
 * Every public method resolves; failures (timeouts, lost links, rejections) become
 * `{ ok: false }`. Commands are serialized, one in flight at a time.
 *
 * Safety rules of this driver:
 *  - a command is `ok: true` only after the pod's answer, or after a later status proved (via
 *    the pod's last programming message number) that the pod received it;
 *  - when the outcome is unknown the driver refuses further delivery until a status settles it
 *    (cancel, suspend and cancel-bolus stay available: they only reduce insulin);
 *  - history only ever contains what the pod confirmed as delivered.
 */
import type { CommandResult, DeviceContext, DeviceMeta, InsulinDose, Millis, PumpDriver, PumpState } from '@buddy/core';
import { newId } from '@buddy/core';
import {
  CancelDeliveryType,
  MINUTE,
  POD,
  PodProgress,
  basalScheduleFromBuddy,
  deliveryIsBolusing,
  deliveryIsSuspended,
  deliveryIsTempBasalRunning,
  deliveredOfBolus,
  podProgressReadyForDelivery,
  roundToSupportedBasalRate,
  type StatusResponseBlock,
} from '../common';
import { DASH_ZERO_BASAL_RATE, type PodComms } from './comms';
import { OmnipodDashSetup } from './driver-setup';
import type { OmnipodDashSettings, OmnipodDriverOptions } from './driver-core';
import { accountUnresolvedPending, endBasalSegment, finishBolus, resumeDelivery, startBolus, startTempBasal, suspendDelivery } from './dose-ledger';
import { errorMessage, OmnipodError, type OmnipodErrorKind } from './errors';
import { describePending, type PendingCommand } from './pending';

export const OMNIPOD_DASH_META: DeviceMeta = {
  id: 'omnipod-dash',
  name: 'Omnipod DASH',
  manufacturer: 'Insulet',
  description: 'Omnipod DASH pod over Bluetooth (port of OmnipodKit). Experimental, bench only: verify with water, never attached to a body.',
  transport: 'ble',
  maturity: 'experimental',
  requiresHardwareCheck: true,
};

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const BOLUS_STEP = POD.pulseSize;
const floorToStep = (units: number): number => Math.floor(units / BOLUS_STEP + 1e-9) * BOLUS_STEP;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Errors after which the pod certainly did not execute the command. */
const CERTAIN_FAILURES: readonly OmnipodErrorKind[] = ['unsent', 'notConnected', 'rejected', 'busy', 'invalid', 'incompatible'];

type ProgramResult =
  | { readonly kind: 'confirmed'; readonly status: StatusResponseBlock }
  /** the answer was lost, but a later status proved the pod received the command */
  | { readonly kind: 'recovered' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'unknown'; readonly error: string };

export class OmnipodDashDriver extends OmnipodDashSetup implements PumpDriver {
  readonly meta: DeviceMeta = OMNIPOD_DASH_META;

  constructor(settings: OmnipodDashSettings, ctx: DeviceContext, options: OmnipodDriverOptions = {}) {
    super(settings, ctx, options);
  }

  private command<T extends { ok: boolean }>(name: string, fn: () => Promise<T | { ok: false; error: string }>): Promise<T | { ok: false; error: string }> {
    return this.serialize(async () => {
      try {
        return await fn();
      } catch (e) {
        this.log.error(`Omnipod DASH ${name}: ${errorMessage(e)}`);
        return fail(`${name}: ${errorMessage(e)}`);
      }
    });
  }

  // ── PumpDriver ─────────────────────────────────────────────────────────────

  /** Without a paired pod there is nothing to connect to yet: setup continues with pairing. */
  connect(): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      if (!this.hasPairedPod) return;
      await this.ensureConnected();
    });
  }

  disconnect(): Promise<void> {
    return this.serialize(async () => {
      this.dropConnection();
    });
  }

  async status(): Promise<PumpState> {
    try {
      await this.serialize(async () => {
        await this.load();
        if (!this.hasPairedPod || !this.setupComplete) return;
        const r = this.record;
        const stale = this.now() - r.lastSync > this.opts.statusFreshMs;
        const owed = r.ledger.bolus !== null || r.ledger.pending !== null;
        if (!stale && !owed) return;
        if (!this.isConnected) await this.ensureConnected(); // the connect itself syncs
        else await this.refreshStatus();
      });
    } catch (e) {
      this.log.warn(`Omnipod DASH status: using last known state (${errorMessage(e)})`);
    }
    try {
      await this.load();
      return this.snapshotState();
    } catch {
      return { reservoirUnits: null, batteryPercent: null, suspended: true, tempBasal: null, bolusing: false, bolusIncrement: BOLUS_STEP, basalIncrement: BOLUS_STEP, lastSync: 0 };
    }
  }

  async history(since: Millis): Promise<InsulinDose[]> {
    try {
      await this.load();
      return this.historyOf(since);
    } catch (e) {
      this.log.error(`Omnipod DASH history: ${errorMessage(e)}`);
      return [];
    }
  }

  // ── guards ─────────────────────────────────────────────────────────────────

  /** Why delivering insulin is not possible right now, or null. */
  private deliveryBlock(opts: { allowSuspended?: boolean } = {}): string | null {
    const r = this.record;
    if (!this.hasPairedPod) return 'No pod is paired';
    if (!this.setupComplete) return 'Pod setup is not complete';
    if (r.fault) return `Pod faulted: ${r.fault.description}`;
    if (r.ledger.pending) return 'The outcome of an earlier command is still unknown; waiting for the pod to confirm it';
    const st = r.lastStatus;
    if (st) {
      if (!podProgressReadyForDelivery(st.podProgress)) return `Pod is not delivering (${st.podProgress === PodProgress.faultEventOccurred ? 'fault' : `progress ${st.podProgress}`})`;
      if (!opts.allowSuspended && (deliveryIsSuspended(st.deliveryStatus) || r.ledger.basal.kind === 'suspended')) return 'Pod is suspended';
    }
    return null;
  }

  // ── programming with unknown outcomes ──────────────────────────────────────

  /**
   * Sends one programming command. The pending record is persisted BEFORE sending, so a crash or a
   * lost answer leaves a trace that the next status resolves.
   */
  private async program(pending: PendingCommand, send: (c: PodComms) => Promise<StatusResponseBlock>): Promise<ProgramResult> {
    const comms = this.comms;
    if (!comms) return { kind: 'failed', error: 'Pod not connected' };
    // A still-unresolved earlier command is about to be replaced (suspend / cancel stay possible):
    // account for it conservatively so its insulin does not vanish from the history.
    const prior = this.record.ledger.pending;
    if (prior) {
      this.log.warn(`Omnipod DASH: replacing the unresolved ${describePending(prior)}, counting it as delivered (conservative)`);
    }
    this.updateLedger((l) => ({ ...accountUnresolvedPending(l, this.now()), pending }));
    try {
      await this.persistStrict();
    } catch (e) {
      // not durable: do not send, so a crash cannot leave a command the record knows nothing about
      this.updateLedger((l) => ({ ...l, pending: null }));
      this.log.error(`Omnipod DASH: could not persist the pending ${pending.kind} command, not sending: ${errorMessage(e)}`);
      return { kind: 'failed', error: `Could not persist the pending command, not sent (${errorMessage(e)})` };
    }
    try {
      const status = await send(comms);
      this.updateLedger((l) => ({ ...l, pending: null }));
      return { kind: 'confirmed', status };
    } catch (e) {
      return this.settleFailure(pending, e);
    }
  }

  private async settleFailure(pending: PendingCommand, e: unknown): Promise<ProgramResult> {
    const message = errorMessage(e);
    if (e instanceof OmnipodError) {
      if (e.kind === 'podFault' && e.fault) {
        await this.handleFault(e.fault);
        return { kind: 'failed', error: message };
      }
      if (CERTAIN_FAILURES.includes(e.kind)) {
        this.updateLedger((l) => ({ ...l, pending: null }));
        await this.persist();
        return { kind: 'failed', error: message };
      }
    }
    // The command may have reached the pod. The old session is not trustworthy any more: open
    // a fresh one; connecting syncs the status, which resolves the pending command.
    this.log.warn(`Omnipod DASH: outcome of the ${pending.kind} command is unknown (${message}), resynchronising`);
    this.lastPendingOutcome = null;
    this.dropConnection();
    try {
      await this.ensureConnected();
    } catch (re) {
      this.log.warn(`Omnipod DASH: could not resynchronise: ${errorMessage(re)}`);
    }
    await this.persist();
    if (this.lastPendingOutcome === 'received') return { kind: 'recovered' };
    if (this.lastPendingOutcome === 'notReceived') return { kind: 'failed', error: `The pod did not receive the command (${message})` };
    return { kind: 'unknown', error: `Outcome unknown, it will be settled on the next sync (${message})` };
  }

  private pendingBase(comms: PodComms): { messageNumber: number; sentAt: Millis; priorProgSeq: number | null } {
    return { messageNumber: comms.messageNumber, sentAt: this.now(), priorProgSeq: this.record.lastStatus?.lastProgrammingMessageSeqNum ?? null };
  }

  // ── commands ───────────────────────────────────────────────────────────────

  bolus(units: number, options: { readonly automatic: boolean }): Promise<CommandResult> {
    return this.command('bolus', async () => {
      await this.load();
      if (!Number.isFinite(units) || units <= 0) return fail(`Invalid bolus amount ${units}`);
      const amount = round3(floorToStep(units));
      if (amount < BOLUS_STEP) return fail(`Bolus ${units} U is below the ${BOLUS_STEP} U increment`);
      if (amount > POD.maximumBolusUnits) return fail(`Bolus ${units} U exceeds the ${POD.maximumBolusUnits} U maximum`);
      const early = this.deliveryBlock();
      if (early) return fail(early);
      if (this.record.ledger.bolus) await this.syncNow(); // it may have finished since the last status
      if (this.record.ledger.bolus) return fail('A bolus is already in progress');

      const comms = await this.ensureConnected();
      const block = this.deliveryBlock();
      if (block) return fail(block);
      const st = this.record.lastStatus;
      if (this.record.ledger.bolus || (st && deliveryIsBolusing(st.deliveryStatus))) return fail('A bolus is already in progress');

      const id = newId('omnipod-bolus');
      const base = this.pendingBase(comms);
      const r = await this.program({ kind: 'bolus', ...base, units: amount, automatic: options.automatic, id }, (c) => c.bolus(amount));
      if (r.kind === 'confirmed') {
        this.updateLedger((l) => startBolus(l, { requested: amount, automatic: options.automatic, at: base.sentAt, delivered: deliveredOfBolus(amount, r.status.bolusNotDelivered), id }));
        await this.applyStatus(r.status);
        this.log.info(`Omnipod DASH: bolus ${amount} U started`);
        return { ok: true } as const;
      }
      return r.kind === 'recovered' ? ({ ok: true } as const) : fail(r.error);
    });
  }

  cancelBolus(): Promise<CommandResult> {
    return this.command('cancelBolus', async () => {
      await this.load();
      const running = () => this.record.ledger.bolus !== null || this.record.ledger.pending?.kind === 'bolus';
      if (!running()) return { ok: true } as const;
      const comms = await this.ensureConnected();
      const bolus = this.record.ledger.bolus;
      // A bolus whose outcome is still unknown may be running: cancel it on the pod rather than assume it is not.
      const maybeRunning = this.record.ledger.pending?.kind === 'bolus' || (this.record.lastStatus !== null && deliveryIsBolusing(this.record.lastStatus.deliveryStatus));
      if (!bolus && !maybeRunning) return { ok: true } as const; // finished while connecting
      const r = await this.program({ kind: 'cancel', ...this.pendingBase(comms), deliveryType: CancelDeliveryType.bolus }, (c) => c.cancelDelivery(CancelDeliveryType.bolus));
      if (r.kind === 'failed' || r.kind === 'unknown') return fail(r.error);
      if (r.kind === 'confirmed') {
        this.updateLedger((l) => (l.bolus ? finishBolus(l, deliveredOfBolus(l.bolus.requested, r.status.bolusNotDelivered)) : l));
        await this.applyStatus(r.status);
      }
      const dose = bolus ? this.record.ledger.doses.find((d) => d.id === bolus.id) : undefined;
      this.log.info('Omnipod DASH: bolus cancelled');
      return dose ? ({ ok: true, dose } as const) : ({ ok: true } as const);
    });
  }

  setTempBasal(rate: number, durationMin: number): Promise<CommandResult> {
    return this.command('setTempBasal', async () => {
      await this.load();
      if (!Number.isFinite(rate) || rate < 0 || rate > POD.maximumBasalUnitsPerHour) return fail(`Temp basal rate ${rate} U/h outside 0–${POD.maximumBasalUnitsPerHour}`);
      if (!Number.isFinite(durationMin) || durationMin < 1 || durationMin > POD.maximumTempBasalMinutes) return fail(`Temp basal duration ${durationMin} min outside 1–${POD.maximumTempBasalMinutes}`);
      // the pod programs whole half hours: floor (45 -> 30, never longer than asked), at least 30; the loop re-issues every cycle
      const minutes = Math.max(30, Math.floor(durationMin / 30) * 30);
      const enacted = roundToSupportedBasalRate(rate);
      const early = this.deliveryBlock();
      if (early) return fail(early);
      if (this.record.ledger.bolus) await this.syncNow();
      if (this.record.ledger.bolus) return fail('Pod is bolusing');

      const comms = await this.ensureConnected();
      const block = this.deliveryBlock();
      if (block) return fail(block);
      const st0 = this.record.lastStatus;
      if (this.record.ledger.bolus || (st0 && deliveryIsBolusing(st0.deliveryStatus))) return fail('Pod is bolusing');

      // OmnipodKit cancels a running temp basal before programming the next one
      if (this.record.ledger.basal.kind === 'temp' || (st0 && deliveryIsTempBasalRunning(st0.deliveryStatus))) {
        const c = await this.program({ kind: 'cancel', ...this.pendingBase(comms), deliveryType: CancelDeliveryType.tempBasal }, (x) => x.cancelDelivery(CancelDeliveryType.tempBasal));
        if (c.kind === 'failed' || c.kind === 'unknown') return fail(`Could not cancel the running temp basal: ${c.error}`);
        if (c.kind === 'confirmed') {
          this.updateLedger((l) => endBasalSegment(l, this.now()));
          await this.applyStatus(c.status);
          if (deliveryIsSuspended(c.status.deliveryStatus)) return fail('Pod is suspended');
        }
      }

      const base = this.pendingBase(comms);
      const r = await this.program({ kind: 'tempBasal', ...base, rate: enacted, durationMin: minutes }, (x) => x.setTempBasal(enacted, minutes));
      if (r.kind === 'confirmed') {
        this.updateLedger((l) => startTempBasal(l, { rate: enacted, durationMin: minutes, at: base.sentAt }));
        await this.applyStatus(r.status);
        this.log.info(`Omnipod DASH: temp basal ${enacted} U/h for ${minutes} min`);
        return this.tempBasalResult();
      }
      return r.kind === 'recovered' ? this.tempBasalResult() : fail(r.error);
    });
  }

  /** `ok: true` with the temp basal dose as actually programmed (the duration is the pod's 30-min step), when the ledger holds it. */
  private tempBasalResult(): CommandResult {
    const seg = this.record.ledger.basal;
    const dose = seg.kind === 'temp' ? this.record.ledger.doses.find((d) => d.id === seg.doseId) : undefined;
    return dose ? { ok: true, dose } : { ok: true };
  }

  cancelTempBasal(): Promise<CommandResult> {
    return this.command('cancelTempBasal', async () => {
      await this.load();
      // Never blocked by a pending bolus: cancelling only ever reduces insulin.
      const now = this.now();
      const seg = this.record.ledger.basal;
      const st = this.record.lastStatus;
      // the pod's last status counts too: the ledger may have lost track of a temp basal
      const running =
        (seg.kind === 'temp' && now < seg.startedAt + seg.durationMin * MINUTE * 1000) ||
        this.record.ledger.pending?.kind === 'tempBasal' ||
        (st !== null && deliveryIsTempBasalRunning(st.deliveryStatus));
      if (!running) {
        this.updateLedger((l) => (l.basal.kind === 'temp' ? endBasalSegment(l, now) : l));
        await this.persist();
        return { ok: true } as const;
      }
      const comms = await this.ensureConnected();
      const r = await this.program({ kind: 'cancel', ...this.pendingBase(comms), deliveryType: CancelDeliveryType.tempBasal }, (x) => x.cancelDelivery(CancelDeliveryType.tempBasal));
      if (r.kind === 'failed' || r.kind === 'unknown') return fail(r.error);
      if (r.kind === 'confirmed') {
        this.updateLedger((l) => endBasalSegment(l, this.now()));
        await this.applyStatus(r.status);
      }
      this.log.info('Omnipod DASH: temp basal cancelled');
      return { ok: true } as const;
    });
  }

  suspend(): Promise<CommandResult> {
    return this.command('suspend', async () => {
      await this.load();
      if (!this.hasPairedPod || !this.setupComplete) return fail('Pod setup is not complete');
      const comms = await this.ensureConnected();
      const r = await this.program({ kind: 'cancel', ...this.pendingBase(comms), deliveryType: CancelDeliveryType.all }, (x) => x.cancelDelivery(CancelDeliveryType.all));
      if (r.kind === 'failed' || r.kind === 'unknown') return fail(r.error);
      if (r.kind === 'confirmed') {
        const at = this.now();
        this.updateLedger((l) => suspendDelivery(l.bolus ? finishBolus(l, deliveredOfBolus(l.bolus.requested, r.status.bolusNotDelivered)) : l, at));
        await this.applyStatus(r.status);
      }
      this.log.info('Omnipod DASH: delivery suspended');
      return { ok: true } as const;
    });
  }

  resume(): Promise<CommandResult> {
    return this.command('resume', async () => {
      await this.load();
      if (!this.hasPairedPod || !this.setupComplete) return fail('Pod setup is not complete');
      if (this.record.fault) return fail(`Pod faulted: ${this.record.fault.description}`);
      if (this.record.ledger.pending) return fail('The outcome of an earlier command is still unknown; waiting for the pod to confirm it');
      const comms = await this.ensureConnected();
      const st = this.record.lastStatus;
      if (this.record.ledger.basal.kind !== 'suspended' && st && !deliveryIsSuspended(st.deliveryStatus)) return { ok: true } as const;
      if (this.record.basalSchedule.length === 0) return fail('No basal schedule is stored for this pod');
      const at = this.now();
      let schedule;
      try {
        schedule = basalScheduleFromBuddy(this.record.basalSchedule, DASH_ZERO_BASAL_RATE);
      } catch (e) {
        return fail(errorMessage(e));
      }
      const r = await this.program({ kind: 'basalProgram', ...this.pendingBase(comms) }, (x) => x.setBasalSchedule(schedule, this.scheduleOffsetSeconds(at)));
      if (r.kind === 'failed' || r.kind === 'unknown') return fail(r.error);
      if (r.kind === 'confirmed') {
        this.updateLedger((l) => resumeDelivery(l, this.now()));
        await this.applyStatus(r.status);
      }
      this.log.info('Omnipod DASH: delivery resumed');
      return { ok: true } as const;
    });
  }
}
