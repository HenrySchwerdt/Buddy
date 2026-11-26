/**
 * The MiniMed `PumpDriver`: the command side of `MinimedPumpManager.swift` (`enactBolus`,
 * `cancelBolus`, `enactTempBasal`, `suspendDelivery`, `resumeDelivery`) on top of the command layer
 * of `PumpOpsSession.swift`, from MinimedKit (migrated from ps2/rileylink_ios, MIT License,
 * (c) LoopKit Authors), behind Buddy's `PumpDriver` contract. The pump is reached through a
 * RileyLink.
 *
 * Every public method resolves; failures (timeouts, lost links, rejections) become
 * `{ ok: false }`. Commands are serialized, one in flight at a time.
 *
 * Safety rules of this driver (the same as the Omnipod drivers):
 *  - a command is `ok: true` only after the pump acknowledged it, or after a later read proved
 *    (running bolus, temp basal readback, history record) that the pump took it;
 *  - the command is recorded as pending BEFORE anything is sent; when its outcome is unknown the
 *    driver refuses further delivery until a status read settles it (cancel temp basal, suspend and
 *    cancel bolus stay available: they only reduce insulin);
 *  - history only ever contains what the pump confirmed as delivered.
 *
 * DEVIATIONS from MinimedKit: `cancelBolus` suspends the pump (the only way to stop a bolus) and then
 * resumes it, where MinimedKit leaves the pump suspended for the user to resume; a temp basal is
 * verified by reading it back from the pump after every attempt.
 */
import { newId, type CommandResult, type DeviceContext, type DeviceMeta, type InsulinDose, type Millis, type PumpDriver, type PumpState } from '@buddy/core';
import { errorMessage, isMinimedError, wasNotExecuted } from './errors';
import { MinimedReconciler } from './reconcile';
import type { MinimedDriverOptions, MinimedSettings } from './driver-core';
import { bolusEndsAt, endBasalSegment, finishBolus, resumeDelivery, startBolus, startTempBasal, suspendDelivery, tempBasalEndsAt, type PendingCommand } from './ledger';
import { maximumBasalRate, maximumBolusVolume, roundToSupportedBasalRate, roundToSupportedBolusVolume, type PumpModel } from './models';
import type { MinimedSession, TempBasalAttempt } from './session';

export const MINIMED_META: DeviceMeta = {
  id: 'minimed',
  name: 'Medtronic MiniMed',
  manufacturer: 'Medtronic',
  description: 'Medtronic MiniMed 5xx/7xx pump through a RileyLink (port of MinimedKit). Experimental, not verified on hardware.',
  transport: 'ble',
  maturity: 'experimental',
};

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const MIN = 60_000;
const RATE_TOLERANCE = 0.0126;
const MAX_TEMP_BASAL_MINUTES = 24 * 60;

type ProgramResult =
  | { readonly kind: 'confirmed' }
  /** the answer was lost, but a later read proved the pump took the command */
  | { readonly kind: 'recovered' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'unknown'; readonly error: string };

/** What the setup UI and the pump status card show; read from the record, no radio traffic. */
export interface MinimedPumpStatus {
  readonly configured: boolean;
  readonly problem: string | null;
  readonly model: PumpModel | null;
  readonly reservoirUnits: number | null;
  readonly batteryPercent: number | null;
  readonly suspended: boolean;
  readonly bolusing: boolean;
  readonly lastSync: Millis;
  readonly frequencyMhz: number | null;
  readonly maxBolus: number | null;
  readonly maxBasal: number | null;
  /** a command whose outcome is unknown, in words; null when none */
  readonly pendingCommand: string | null;
  /** the pump runs a percent temp basal, which Buddy cannot dose against */
  readonly percentTempBasal: boolean;
}

export class MinimedDriver extends MinimedReconciler implements PumpDriver {
  readonly meta: DeviceMeta = MINIMED_META;

  constructor(settings: MinimedSettings, ctx: DeviceContext, options: MinimedDriverOptions = {}) {
    super(settings, ctx, options);
  }

  private command<T extends { ok: boolean }>(name: string, fn: () => Promise<T | { ok: false; error: string }>): Promise<T | { ok: false; error: string }> {
    return this.serialize(async () => {
      try {
        return await fn();
      } catch (e) {
        this.log.error(`MiniMed ${name}: ${errorMessage(e)}`);
        return fail(`${name}: ${errorMessage(e)}`);
      }
    });
  }

  // ── PumpDriver ─────────────────────────────────────────────────────────────

  connect(): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      if (this.configurationProblem) return; // nothing to connect to yet: the setup picks the RileyLink and the pump
      await this.ensureConnected();
      try {
        await this.syncNow();
      } catch (e) {
        this.log.warn(`MiniMed: the pump did not answer yet (${errorMessage(e)})`);
      }
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
        if (this.configurationProblem) return;
        const r = this.record;
        const b = r.ledger.bolus;
        const stale = this.now() - r.lastSync > this.opts.statusFreshMs;
        const owed = r.ledger.pending !== null || (b !== null && this.now() >= bolusEndsAt(b));
        if (stale || owed) await this.syncNow();
      });
    } catch (e) {
      this.log.warn(`MiniMed status: using last known state (${errorMessage(e)})`);
    }
    try {
      await this.load();
      return this.snapshotState();
    } catch {
      return { reservoirUnits: null, batteryPercent: null, suspended: true, tempBasal: null, bolusing: false, bolusIncrement: 0.1, basalIncrement: 0.05, lastSync: 0 };
    }
  }

  async history(since: Millis): Promise<InsulinDose[]> {
    try {
      await this.load();
      return this.historyOf(since);
    } catch (e) {
      this.log.error(`MiniMed history: ${errorMessage(e)}`);
      return [];
    }
  }

  // ── helpers for the setup UI ───────────────────────────────────────────────

  /** What the driver knows about the pump, without radio traffic. */
  async pumpStatus(): Promise<MinimedPumpStatus> {
    await this.load();
    const r = this.record;
    const p = r.ledger.pending;
    const state = this.snapshotState();
    return {
      configured: this.configurationProblem === null,
      problem: this.configurationProblem,
      model: r.pumpModel,
      reservoirUnits: r.reservoirUnits,
      batteryPercent: r.batteryPercent,
      suspended: state.suspended,
      bolusing: state.bolusing,
      lastSync: r.lastSync,
      frequencyMhz: r.frequencyMhz,
      maxBolus: r.maxBolus,
      maxBasal: r.maxBasal,
      pendingCommand: p ? (p.kind === 'bolus' ? `${p.units} U bolus` : p.kind === 'tempBasal' ? (p.durationMin === 0 ? 'cancel temp basal' : `${p.rate} U/h temp basal`) : p.kind) : null,
      percentTempBasal: r.percentTempBasal,
    };
  }

  /** Reads the pump now (history included); resolves with the outcome instead of throwing. */
  refresh(): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.command('refresh', async () => {
      await this.load();
      const problem = this.configurationProblem;
      if (problem) return fail(problem);
      await this.syncNow({ forceHistory: true });
      return { ok: true } as const;
    });
  }

  /** Scans the region's channels for the pump (the setup runs this once, e.g. when the pump does not answer). */
  tune(): Promise<{ ok: true; frequencyMhz: number } | { ok: false; error: string }> {
    return this.command('tune', async () => {
      await this.load();
      const problem = this.configurationProblem;
      if (problem) return fail(problem);
      const r = await this.tuneNow();
      return { ok: true, frequencyMhz: r.frequencyMhz } as const;
    });
  }

  // ── guards ─────────────────────────────────────────────────────────────────

  /** Why delivering insulin is not possible right now, or null. */
  private deliveryBlock(opts: { allowSuspended?: boolean } = {}): string | null {
    const r = this.record;
    const problem = this.configurationProblem;
    if (problem) return problem;
    if (r.ledger.pending) return 'The outcome of an earlier command is still unknown; waiting for the pump to confirm it';
    if (!opts.allowSuspended && (r.suspended || r.ledger.basal.kind === 'suspended')) return 'Pump is suspended';
    if (r.reservoirUnits !== null && r.reservoirUnits <= 0) return 'The reservoir is empty';
    return null;
  }

  /** A dosing command needs a recent look at the pump (suspended? bolusing?): read it when it is stale or a command is unresolved. */
  private async ensureFresh(): Promise<void> {
    const stale = this.now() - this.record.lastSync > this.opts.statusFreshMs;
    if (stale || this.record.ledger.pending) await this.syncNow();
  }

  private async knownModel(session: MinimedSession): Promise<PumpModel> {
    const m = this.record.pumpModel ?? (await session.getPumpModel());
    if (this.record.pumpModel === null) this.update({ pumpModel: m });
    return m;
  }

  // ── programming with unknown outcomes ──────────────────────────────────────

  /**
   * Sends one command. The pending record is persisted BEFORE sending, so a crash or a lost
   * answer leaves a trace that the next read resolves.
   */
  private async program(pending: PendingCommand, send: (s: MinimedSession) => Promise<void>): Promise<ProgramResult> {
    const session = this.session;
    if (!session) return { kind: 'failed', error: 'Pump not connected' };
    this.accountPending(); // an unresolved earlier command is about to be replaced (cancel / suspend stay possible)
    this.updateLedger((l) => ({ ...l, pending }));
    try {
      await this.persistStrict();
    } catch (e) {
      // not durable: do not send, so a crash cannot leave a command the record knows nothing about
      this.updateLedger((l) => ({ ...l, pending: null }));
      this.log.error(`MiniMed: could not persist the pending command, not sending: ${errorMessage(e)}`);
      return { kind: 'failed', error: `Could not persist the pending command, not sent (${errorMessage(e)})` };
    }
    try {
      await send(session);
      this.updateLedger((l) => ({ ...l, pending: null }));
      return { kind: 'confirmed' };
    } catch (e) {
      return this.settleFailure(pending, e);
    }
  }

  private async settleFailure(pending: PendingCommand, e: unknown): Promise<ProgramResult> {
    const message = errorMessage(e);
    if (wasNotExecuted(e)) {
      this.updateLedger((l) => ({ ...l, pending: null }));
      await this.persist();
      return { kind: 'failed', error: message };
    }
    // The pump may have taken the command: read it back. A lost link may have left the session unusable.
    this.log.warn(`MiniMed: outcome of the ${pending.kind} command is unknown (${message}), reading the pump`);
    this.lastPendingOutcome = null;
    if (isMinimedError(e, 'device')) this.dropConnection();
    try {
      await this.syncNow({ forceHistory: pending.kind === 'bolus' });
    } catch (re) {
      this.log.warn(`MiniMed: could not resynchronise: ${errorMessage(re)}`);
    }
    await this.persist();
    if (this.lastPendingOutcome === 'received') return { kind: 'recovered' };
    if (this.lastPendingOutcome === 'notReceived') return { kind: 'failed', error: `The pump did not take the command (${message})` };
    return { kind: 'unknown', error: `Outcome unknown, it will be settled on the next read (${message})` };
  }

  // ── bolus ──────────────────────────────────────────────────────────────────

  bolus(units: number, options: { readonly automatic: boolean }): Promise<CommandResult> {
    return this.command('bolus', async () => {
      await this.load();
      if (!Number.isFinite(units) || units <= 0) return fail(`Invalid bolus amount ${units}`);
      const early = this.deliveryBlock();
      if (early) return fail(early);
      const session = await this.ensureConnected();
      const model = await this.knownModel(session);
      const amount = Math.round(roundToSupportedBolusVolume(model, units) * 1000) / 1000;
      if (amount <= 0) return fail(`Bolus ${units} U is below the smallest step of this pump`);
      const limit = Math.min(this.record.maxBolus ?? maximumBolusVolume, maximumBolusVolume);
      if (amount > limit + 1e-9) return fail(`Bolus ${units} U exceeds the pump's ${limit} U maximum bolus`);
      await this.ensureFresh();
      const block = this.deliveryBlock();
      if (block) return fail(block);
      if (this.record.ledger.bolus || this.record.pumpBolusing) return fail('A bolus is already in progress');
      const reservoir = this.record.reservoirUnits;
      if (reservoir !== null && amount > reservoir) return fail(`Bolus ${amount} U exceeds the ${reservoir} U in the reservoir`);

      const id = newId('minimed-bolus');
      const r = await this.program({ kind: 'bolus', id, units: amount, automatic: options.automatic, sentAt: this.now() }, (s) => s.setNormalBolus(amount));
      if (r.kind === 'confirmed') {
        this.updateLedger((l) => startBolus(l, model, { id, units: amount, automatic: options.automatic, at: this.now() }));
        this.update({ pumpBolusing: true });
        await this.persist();
        this.log.info(`MiniMed: bolus ${amount} U started`);
        return { ok: true } as const;
      }
      return r.kind === 'recovered' ? ({ ok: true } as const) : fail(r.error);
    });
  }

  cancelBolus(): Promise<CommandResult> {
    return this.command('cancelBolus', async () => {
      await this.load();
      const l0 = this.record.ledger;
      if (!l0.bolus && l0.pending?.kind !== 'bolus' && !this.record.pumpBolusing) return { ok: true } as const;
      const bolusId = l0.bolus?.id ?? (l0.pending?.kind === 'bolus' ? l0.pending.id : null);
      // the only way to stop a bolus is to suspend the pump
      const stopped = await this.suspendNow();
      if (stopped.kind === 'failed' || stopped.kind === 'unknown') return fail(stopped.error);
      // ... and then give the basal back (DEVIATION: MinimedKit leaves the pump suspended)
      const resumed = await this.resumeNow();
      if (resumed.kind === 'failed' || resumed.kind === 'unknown') this.log.warn(`MiniMed: the bolus was stopped but the pump could not be resumed: ${resumed.error}`);
      this.log.info('MiniMed: bolus cancelled');
      const dose = bolusId ? this.record.ledger.doses.find((d) => d.id === bolusId) : undefined;
      return dose ? ({ ok: true, dose } as const) : ({ ok: true } as const);
    });
  }

  // ── temp basal ─────────────────────────────────────────────────────────────

  setTempBasal(rate: number, durationMin: number): Promise<CommandResult> {
    return this.command('setTempBasal', async () => {
      await this.load();
      if (!Number.isFinite(rate) || rate < 0 || rate > maximumBasalRate) return fail(`Temp basal rate ${rate} U/h outside 0–${maximumBasalRate}`);
      if (!Number.isFinite(durationMin) || durationMin < 1 || durationMin > MAX_TEMP_BASAL_MINUTES) return fail(`Temp basal duration ${durationMin} min outside 1–${MAX_TEMP_BASAL_MINUTES}`);
      const early = this.deliveryBlock();
      if (early) return fail(early);
      const session = await this.ensureConnected();
      const model = await this.knownModel(session);
      const enacted = roundToSupportedBasalRate(model, rate);
      // the pump programs whole half hours: floor (45 -> 30, never longer than asked), at least 30; the loop re-issues every cycle
      const minutes = Math.max(30, Math.floor(durationMin / 30) * 30);
      const limit = Math.min(this.record.maxBasal ?? maximumBasalRate, maximumBasalRate);
      if (enacted > limit + 1e-9) return fail(`Temp basal ${rate} U/h exceeds the pump's ${limit} U/h maximum basal rate`);
      await this.ensureFresh();
      const block = this.deliveryBlock();
      if (block) return fail(block);
      return this.programTempBasal(session, enacted, minutes);
    });
  }

  cancelTempBasal(): Promise<CommandResult> {
    return this.command('cancelTempBasal', async () => {
      await this.load();
      const problem = this.configurationProblem;
      if (problem) return fail(problem);
      // Never blocked by a pending command: cancelling only ever reduces insulin.
      const now = this.now();
      const seg = this.record.ledger.basal;
      const running = (seg.kind === 'temp' && now < tempBasalEndsAt(seg)) || this.record.ledger.pending?.kind === 'tempBasal' || this.record.percentTempBasal;
      if (!running) {
        this.updateLedger((l) => (l.basal.kind === 'temp' ? endBasalSegment(l, now) : l));
        await this.persist();
        return { ok: true } as const;
      }
      const session = await this.ensureConnected();
      const r = await this.programTempBasal(session, 0, 0);
      if (r.ok) this.log.info('MiniMed: temp basal cancelled');
      return r;
    });
  }

  /** Programs a temp basal (`durationMin` 0 cancels) and checks the pump's readback; see `judgeTempBasal`. */
  private async programTempBasal(session: MinimedSession, rate: number, durationMin: number): Promise<CommandResult> {
    const prior = this.record.ledger.basal;
    const sentAt = this.now();
    const pending: PendingCommand = {
      kind: 'tempBasal',
      rate,
      durationMin,
      sentAt,
      priorRate: prior.kind === 'temp' ? prior.rate : null,
      priorRemainingMin: prior.kind === 'temp' ? Math.max(0, (tempBasalEndsAt(prior) - sentAt) / MIN) : 0,
    };
    this.accountPending();
    this.updateLedger((l) => ({ ...l, pending }));
    try {
      await this.persistStrict();
    } catch (e) {
      this.updateLedger((l) => ({ ...l, pending: null }));
      return fail(`Could not persist the pending command, not sent (${errorMessage(e)})`);
    }
    const attempt = await session.setTempBasal(rate, durationMin);
    if (attempt.uncertain && isMinimedError(attempt.uncertain, 'device')) this.dropConnection();
    const verdict = this.judgeTempBasal(pending, attempt);

    if (verdict.kind === 'unknown') {
      this.log.warn(`MiniMed: outcome of the temp basal command is unknown (${verdict.error})`);
      await this.persist();
      return fail(verdict.error);
    }
    const at = this.now();
    this.updateLedger((l) => {
      const cleared = { ...l, pending: null };
      if (verdict.kind === 'failed') return attempt.readback ? this.reconcileTemp(cleared, attempt.readback, at) : cleared;
      return durationMin === 0 ? endBasalSegment(cleared, at) : startTempBasal(cleared, { rate, durationMin, at: sentAt });
    });
    await this.persist();
    if (verdict.kind === 'failed') return fail(verdict.error);
    this.log.info(durationMin === 0 ? 'MiniMed: temp basal cancelled' : `MiniMed: temp basal ${rate} U/h for ${durationMin} min`);
    return this.tempBasalResult();
  }

  /** What to make of the attempt: the pump's ack and its readback are two witnesses; a contradiction is a failure, silence an unknown. */
  private judgeTempBasal(p: Extract<PendingCommand, { kind: 'tempBasal' }>, a: TempBasalAttempt): { kind: 'confirmed' } | { kind: 'failed'; error: string } | { kind: 'unknown'; error: string } {
    if (a.rejection) return { kind: 'failed', error: a.rejection.message };
    const t = a.readback;
    if (t === null) {
      if (a.acked) return { kind: 'confirmed' }; // the pump acknowledged the arguments; only the readback failed
      return { kind: 'unknown', error: `Outcome unknown, it will be settled on the next read (${a.uncertain?.message ?? 'no answer'})` };
    }
    const elapsedMin = Math.ceil((this.now() - p.sentAt) / MIN);
    const matches =
      p.durationMin === 0
        ? t.timeRemainingMin <= 0
        : t.rateType === 'absolute' && Math.abs(t.rate - p.rate) <= RATE_TOLERANCE && t.timeRemainingMin <= p.durationMin && t.timeRemainingMin >= p.durationMin - elapsedMin - 3;
    if (matches) return { kind: 'confirmed' };
    return { kind: 'failed', error: a.acked ? 'The pump acknowledged the temp basal but reports a different one running' : `The pump did not take the temp basal (${a.uncertain?.message ?? 'no answer'})` };
  }

  /** `ok: true` with the temp basal dose as actually programmed (the duration is the pump's 30-min step), when the ledger holds it. */
  private tempBasalResult(): CommandResult {
    const seg = this.record.ledger.basal;
    const dose = seg.kind === 'temp' ? this.record.ledger.doses.find((d) => d.id === seg.doseId) : undefined;
    return dose ? { ok: true, dose } : { ok: true };
  }

  // ── suspend / resume ───────────────────────────────────────────────────────

  suspend(): Promise<CommandResult> {
    return this.command('suspend', async () => {
      await this.load();
      const problem = this.configurationProblem;
      if (problem) return fail(problem);
      const r = await this.suspendNow();
      if (r.kind === 'failed' || r.kind === 'unknown') return fail(r.error);
      this.log.info('MiniMed: delivery suspended');
      return { ok: true } as const;
    });
  }

  resume(): Promise<CommandResult> {
    return this.command('resume', async () => {
      await this.load();
      const problem = this.configurationProblem;
      if (problem) return fail(problem);
      if (this.record.ledger.pending) return fail('The outcome of an earlier command is still unknown; waiting for the pump to confirm it');
      const r = await this.resumeNow();
      if (r.kind === 'failed' || r.kind === 'unknown') return fail(r.error);
      this.log.info('MiniMed: delivery resumed');
      return { ok: true } as const;
    });
  }

  private async suspendNow(): Promise<ProgramResult> {
    await this.ensureConnected();
    const r = await this.program({ kind: 'suspend', sentAt: this.now() }, (s) => s.setSuspendResume('suspend'));
    if (r.kind === 'confirmed') {
      const at = this.now();
      const model = this.record.pumpModel;
      // a suspend stops a running bolus: count what was delivered until now
      this.updateLedger((l) => suspendDelivery(model && l.bolus ? finishBolus(l, model, at) : l, at));
      this.update({ suspended: true, pumpBolusing: false });
      await this.persist();
    }
    return r;
  }

  private async resumeNow(): Promise<ProgramResult> {
    const session = await this.ensureConnected();
    if (!this.record.suspended && this.record.ledger.basal.kind !== 'suspended') return { kind: 'confirmed' };
    const r = await this.program({ kind: 'resume', sentAt: this.now() }, (s) => s.setSuspendResume('resume'));
    if (r.kind === 'confirmed') {
      const at = this.now();
      this.updateLedger((l) => resumeDelivery(l, at));
      this.update({ suspended: false });
      // the pump may carry on with a temp basal that was running before: ask it
      const temp = await session.getTempBasal().catch(() => null);
      if (temp) this.updateLedger((l) => this.reconcileTemp(l, temp, at));
      await this.persist();
    }
    return r;
  }

}
