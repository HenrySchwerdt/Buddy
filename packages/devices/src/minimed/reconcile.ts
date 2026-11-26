/**
 * Status bookkeeping of the MiniMed driver: reads the pump and reconciles the record and the dose
 * ledger with what it reports. Port of `MinimedPumpManager.refreshPumpData`, `fetchPumpHistory`
 * and `reconcilePendingDosesWith` of MinimedKit (migrated from ps2/rileylink_ios, MIT License,
 * (c) LoopKit Authors), with the unknown-outcome rules of Buddy's pump drivers:
 *  - a command whose answer was lost stays `pending` (and blocks dosing) until a status read, a
 *    temp basal read or the pump history proves whether the pump took it;
 *  - history only ever contains what the pump confirmed as delivered.
 */
import type { Millis, PumpState } from '@buddy/core';
import { MinimedCore } from './driver-core';
import { errorMessage, isMinimedError } from './errors';
import { basalScheduleToBuddy } from './basal-schedule';
import { bolusesFromHistory, tempBasalsFromHistory, type HistoryBolus } from './history/doses';
import { millisToPumpClock, pumpClockToMillis, type TimestampedHistoryEvent } from './history/events';
import {
  accountUnresolvedPending,
  bolusEndsAt,
  describePending,
  endBasalSegment,
  finishBolus,
  importDose,
  ledgerHistory,
  resumeDelivery,
  startBolus,
  startTempBasal,
  suspendDelivery,
  tempBasalEndsAt,
  verifyBolus,
  type LedgerState,
  type PendingCommand,
} from './ledger';
import { batteryPercentFromVolts, bolusDeliveryTimeMs, DEFAULT_FREQUENCY_MHZ, type PumpModel } from './models';
import type { BatteryReading, PumpReading, TempBasalReading } from './session';
import { MinimedSession } from './session';

const MIN = 60_000;
/** Pump clock more than this off: set it (MinimedKit: 20 s). */
const CLOCK_TOLERANCE_MS = 20_000;
/** Matching window between a Buddy dose and a history record. */
const MATCH_WINDOW_MS = 3 * MIN;
/** How far back the first history read goes (the longest insulin action we care about). */
const INITIAL_HISTORY_MS = 6 * 60 * MIN;
const RATE_TOLERANCE = 0.0126;
/** The history record of a bolus is written when delivery ends; give it this long before calling it missing. */
const HISTORY_GRACE_MS = 90_000;

export type PendingOutcome = 'received' | 'notReceived' | 'unknown';

interface Readings {
  readonly at: Millis;
  readonly model: PumpModel;
  readonly pump: PumpReading;
  readonly temp: TempBasalReading | null;
  readonly reservoir: number;
  readonly battery: BatteryReading | null;
  /** null when the history was not read (or could not be) */
  readonly history: readonly TimestampedHistoryEvent[] | null;
  readonly utcOffsetSeconds: number;
}

const close = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

export class MinimedReconciler extends MinimedCore {
  /** Outcome of the most recent resolution of a command of unknown outcome. */
  protected lastPendingOutcome: PendingOutcome | null = null;
  private limitsReadThisSession = false;
  /** Pump clock minus phone clock at the last read (ms); 0 after the clock was set. */
  private clockOffsetMs: number | null = null;
  private lastTuneAttempt = 0;

  // ── connection ─────────────────────────────────────────────────────────────

  /** Makes sure the RileyLink is connected and a session is open (no pump traffic). */
  protected async ensureConnected(): Promise<MinimedSession> {
    await this.load();
    if (this.session && this.device?.isConnected) return this.session;
    this.session = null;
    this.limitsReadThisSession = false;
    const device = await this.openRadio();
    this.session = this.makeSession(device);
    return this.session;
  }

  // ── reading the pump ───────────────────────────────────────────────────────

  /** Is a history read needed to settle something or to catch up? */
  private historyDue(pump: PumpReading, at: Millis, force: boolean): boolean {
    const r = this.record;
    const l = r.ledger;
    if (force || r.lastHistorySync === 0) return true;
    if (l.bolus && !pump.bolusing) return true; // just finished: learn what was delivered
    if (l.pending && this.pendingNeedsHistory(l.pending, at, r.pumpModel)) return true;
    if (l.unverified.some((u) => at - u.finishedAt < 20 * MIN) && at - r.lastHistorySync >= 2 * MIN) return true;
    return at - r.lastHistorySync >= this.opts.historyEveryMs;
  }

  private pendingNeedsHistory(p: PendingCommand, at: Millis, model: PumpModel | null): boolean {
    if (p.kind === 'bolus') return model !== null && at >= p.sentAt + bolusDeliveryTimeMs(model, p.units) - 15_000;
    if (p.kind === 'tempBasal') return p.durationMin > 0 && at >= p.sentAt + p.durationMin * MIN - 2 * MIN;
    return false;
  }

  /**
   * Reads the pump (model, status, battery, reservoir, clock, temp basal and, when due, the
   * history) and reconciles the record and the dose ledger with it. Throws when the pump cannot
   * be read; the record is then left as it was.
   */
  protected async syncNow(o: { readonly forceHistory?: boolean } = {}): Promise<void> {
    const session = await this.ensureConnected();
    try {
      await this.readAndApply(session, o.forceHistory ?? false);
    } catch (e) {
      await this.troubleshoot(session, e);
      throw e;
    }
  }

  private async readAndApply(session: MinimedSession, forceHistory: boolean): Promise<void> {
    let at = this.now();
    const utcOffsetSeconds = this.opts.utcOffsetSeconds(at);
    const model = await session.getPumpModel();
    if (this.settingsModel && this.settingsModel !== model) this.log.warn(`MiniMed: the pump reports model ${model}, not the configured ${this.settingsModel}; using ${model}`);
    const pump = await session.getPumpStatus();
    const battery = await session.getBattery().catch(() => null);
    const { units: reservoir, clock } = await session.getRemainingInsulin();
    const temp = await session.getTempBasal().catch(() => null);

    if (!this.limitsReadThisSession) {
      this.limitsReadThisSession = true;
      await this.readLimits(session);
    }
    await this.checkClock(session, pumpClockToMillis(clock, utcOffsetSeconds), utcOffsetSeconds, pump);
    at = this.now();

    let history: readonly TimestampedHistoryEvent[] | null = null;
    if (this.historyDue(pump, at, forceHistory)) {
      const since = this.record.lastHistorySync === 0 ? at - INITIAL_HISTORY_MS : this.record.lastHistorySync - 2 * MIN;
      try {
        history = (await session.getHistoryEvents(since, utcOffsetSeconds)).events;
      } catch (e) {
        this.log.warn(`MiniMed: could not read the pump history: ${errorMessage(e)}`);
      }
    }
    this.applyReadings({ at, model, pump, temp, reservoir, battery, history, utcOffsetSeconds });
    await this.persist();
  }

  private get settingsModel(): string | null {
    const m = this.settings.pumpModel.trim();
    return m === '' ? null : m;
  }

  private async readLimits(session: MinimedSession): Promise<void> {
    try {
      const s = await session.getSettings();
      this.update({ maxBolus: s.maxBolus, maxBasal: s.maxBasal });
      if (this.record.basalSchedule.length === 0) {
        const schedule = await session.getBasalSchedule().catch(() => null);
        if (schedule) this.update({ basalSchedule: basalScheduleToBuddy(schedule) });
      }
    } catch (e) {
      this.limitsReadThisSession = false; // try again on the next sync
      this.log.warn(`MiniMed: could not read the pump settings: ${errorMessage(e)}`);
    }
  }

  /** Sets the pump's clock when it is off by more than 20 s and nothing is being delivered (`refreshPumpData`). */
  private async checkClock(session: MinimedSession, pumpMillis: number, utcOffsetSeconds: number, pump: PumpReading): Promise<void> {
    const diff = pumpMillis - this.now();
    this.clockOffsetMs = diff;
    if (Math.abs(diff) <= CLOCK_TOLERANCE_MS || !this.opts.autoSetTime) return;
    if (pump.bolusing || this.record.ledger.bolus || this.record.ledger.pending) return;
    this.log.warn(`MiniMed: the pump clock is ${Math.round(diff / 1000)} s off, setting it`);
    try {
      await session.setTime(millisToPumpClock(this.now(), utcOffsetSeconds));
      this.clockOffsetMs = 0;
    } catch (e) {
      this.log.warn(`MiniMed: could not set the pump clock: ${errorMessage(e)}`);
    }
  }

  /** After a failed read: re-tune the radio when it has not been tuned for a while (`troubleshootPumpComms`). */
  private async troubleshoot(session: MinimedSession, e: unknown): Promise<void> {
    if (!isMinimedError(e, 'noResponse')) return;
    const at = this.now();
    if (at - this.record.lastTuned < this.opts.tuneToleranceMs || at - this.lastTuneAttempt < this.opts.tuneToleranceMs) return;
    this.lastTuneAttempt = at;
    try {
      const r = await session.tuneRadio(this.region, this.record.frequencyMhz ?? DEFAULT_FREQUENCY_MHZ[this.region], 1);
      this.update({ frequencyMhz: r.bestFrequencyMhz, lastTuned: at });
      this.log.info('MiniMed: radio re-tuned');
      await this.persist();
    } catch (te) {
      this.log.warn(`MiniMed: radio tune failed: ${errorMessage(te)}`);
    }
  }

  /** Scans the region's channels for the pump and remembers the best (the setup UI calls this; runs inside a serialized command). */
  protected async tuneNow(): Promise<{ frequencyMhz: number }> {
    await this.load();
    const session = await this.ensureConnected();
    const r = await session.tuneRadio(this.region, this.record.frequencyMhz ?? DEFAULT_FREQUENCY_MHZ[this.region]);
    this.update({ frequencyMhz: r.bestFrequencyMhz, lastTuned: this.now() });
    await this.persist();
    return { frequencyMhz: r.bestFrequencyMhz };
  }

  // ── reconciliation ─────────────────────────────────────────────────────────

  protected applyReadings(r: Readings): void {
    this.update({
      pumpModel: r.model,
      reservoirUnits: r.reservoir,
      batteryPercent: r.battery ? batteryPercentFromVolts(r.battery.volts, this.opts.batteryChemistry) : this.record.batteryPercent,
      suspended: r.pump.suspended,
      pumpBolusing: r.pump.bolusing,
      percentTempBasal: r.temp?.rateType === 'percent' && r.temp.timeRemainingMin > 0,
      utcOffsetSeconds: r.utcOffsetSeconds,
      lastSync: r.at,
    });
    if (r.battery?.status === 'low') this.log.warn('MiniMed: the pump reports a low battery');
    if (this.record.percentTempBasal) this.log.warn('MiniMed: the pump runs a percent temp basal; Buddy cannot account for it, set the pump to units per hour');

    // a bolus that ended is closed with an estimate first, so that the history below can replace the estimate with the real amount
    this.updateLedger((l) => this.reconcileBolus(l, r));
    if (r.history) {
      this.updateLedger((l) => this.importHistory(l, bolusesFromHistory(r.history!)));
      this.update({ lastHistorySync: r.at });
    }
    const pending = this.record.ledger.pending;
    if (pending) this.settlePending(pending, r);

    this.updateLedger((l) => this.reconcileBolus(l, r));
    this.updateLedger((l) => this.reconcileSuspend(l, r));
    this.updateLedger((l) => this.reconcileTemp(l, r.temp, r.at));
  }

  /** Bolus records of the history: they refine Buddy's own estimates, anything else came from the pump's buttons. */
  private importHistory(ledger: LedgerState, boluses: readonly HistoryBolus[]): LedgerState {
    let l = ledger;
    for (const b of boluses) {
      const unverified = l.unverified.find((u) => close(u.date, b.date, MATCH_WINDOW_MS) && close(u.requested, b.programmed, 0.03));
      if (unverified) {
        l = verifyBolus(l, unverified.id, b.amount);
        continue;
      }
      const active = l.bolus;
      if (active && close(active.sentAt, b.date, MATCH_WINDOW_MS) && close(active.requested, b.programmed, 0.03)) continue;
      const p = l.pending;
      if (p?.kind === 'bolus' && close(p.sentAt, b.date, MATCH_WINDOW_MS) && close(p.units, b.programmed, 0.03)) continue; // settled with the pending command
      const known = l.doses.some((d) => (d.kind === 'bolus' || d.kind === 'smb') && (d.id === b.id || (close(d.date, b.date, MATCH_WINDOW_MS) && close(d.units, b.amount, 0.06))));
      if (!known && b.amount > 0) l = importDose(l, { kind: 'bolus', date: b.date, units: b.amount, id: b.id });
    }
    return l;
  }

  private reconcileBolus(l: LedgerState, r: Readings): LedgerState {
    const b = l.bolus;
    if (!b || r.pump.bolusing) return l;
    // the pump stopped bolusing: it ran to its end, or something cut it short (a suspend, the pump's buttons)
    return finishBolus(l, r.model, Math.min(r.at, bolusEndsAt(b)));
  }

  private reconcileSuspend(l: LedgerState, r: Readings): LedgerState {
    if (r.pump.suspended && l.basal.kind !== 'suspended') return suspendDelivery(l, r.at);
    if (!r.pump.suspended && l.basal.kind === 'suspended') return resumeDelivery(l, r.at);
    return l;
  }

  protected reconcileTemp(l: LedgerState, t: TempBasalReading | null, at: Millis): LedgerState {
    if (t === null || l.basal.kind === 'suspended') return l; // unreadable, or nothing flows anyway
    const seg = l.basal;
    if (t.timeRemainingMin <= 0 || t.rateType === 'percent') return seg.kind === 'temp' ? endBasalSegment(l, Math.min(at, tempBasalEndsAt(seg))) : l;
    if (seg.kind === 'temp' && close(seg.rate, t.rate, RATE_TOLERANCE) && close((tempBasalEndsAt(seg) - at) / MIN, t.timeRemainingMin, 3)) return l;
    // the pump runs a temp basal the ledger does not know (set at the pump) or a different one
    return startTempBasal(l, { rate: t.rate, durationMin: t.timeRemainingMin, at });
  }

  // ── pending commands ───────────────────────────────────────────────────────

  /** Decides what happened to a command whose outcome was unknown, from what the pump reports now. */
  protected resolvePending(p: PendingCommand, r: Readings): PendingOutcome {
    switch (p.kind) {
      case 'suspend':
        return r.pump.suspended ? 'received' : 'notReceived';
      case 'resume':
        return r.pump.suspended ? 'notReceived' : 'received';
      case 'tempBasal':
        return this.resolveTempBasal(p, r);
      case 'bolus':
        return this.resolveBolus(p, r).outcome;
    }
  }

  private resolveBolus(p: Extract<PendingCommand, { kind: 'bolus' }>, r: Readings): { outcome: PendingOutcome; event?: HistoryBolus } {
    if (r.pump.bolusing) return { outcome: 'received' }; // no bolus ran before the command, so this one is ours
    const event = r.history ? bolusesFromHistory(r.history).find((b) => close(b.date, p.sentAt, MATCH_WINDOW_MS) && close(b.programmed, p.units, 0.03)) : undefined;
    if (event) return { outcome: 'received', event };
    const expectedEnd = p.sentAt + bolusDeliveryTimeMs(r.model, p.units);
    if (r.at < expectedEnd - 15_000) return { outcome: 'notReceived' }; // it would still be running
    if (r.history && r.at >= expectedEnd + HISTORY_GRACE_MS) return { outcome: 'notReceived' }; // finished by now and the history does not know it
    return { outcome: 'unknown' };
  }

  private resolveTempBasal(p: Extract<PendingCommand, { kind: 'tempBasal' }>, r: Readings): PendingOutcome {
    const t = r.temp;
    if (p.durationMin === 0) {
      // a cancel: the wanted state is "no temp basal"
      if (t === null) return 'unknown';
      return t.timeRemainingMin <= 0 ? 'received' : 'notReceived';
    }
    const elapsedMin = Math.ceil((r.at - p.sentAt) / MIN);
    if (t && t.rateType === 'absolute' && t.timeRemainingMin > 0 && close(t.rate, p.rate, RATE_TOLERANCE) && t.timeRemainingMin <= p.durationMin && t.timeRemainingMin >= p.durationMin - elapsedMin - 3) return 'received';
    if (elapsedMin < p.durationMin - 2) return t === null ? 'unknown' : 'notReceived'; // it would still be running
    // it would have run its course: only the history can tell
    if (!r.history) return 'unknown';
    return tempBasalsFromHistory(r.history).some((h) => close(h.date, p.sentAt, MATCH_WINDOW_MS) && close(h.rate, p.rate, RATE_TOLERANCE)) ? 'received' : 'notReceived';
  }

  private settlePending(p: PendingCommand, r: Readings): void {
    const bolusResolution = p.kind === 'bolus' ? this.resolveBolus(p, r) : null;
    const outcome = bolusResolution ? bolusResolution.outcome : this.resolvePending(p, r);
    this.lastPendingOutcome = outcome;
    if (outcome === 'unknown') {
      this.log.warn(`MiniMed: cannot tell whether the pump took the ${describePending(p)}`);
      return;
    }
    if (outcome === 'notReceived') {
      this.log.warn(`MiniMed: the pump did not take the ${describePending(p)}`);
      this.updateLedger((l) => ({ ...l, pending: null }));
      return;
    }
    this.log.info(`MiniMed: the pump took the ${describePending(p)}`);
    this.updateLedger((l) => ({ ...this.applyReceived({ ...l, pending: null }, p, r, bolusResolution?.event), pending: null }));
  }

  private applyReceived(l: LedgerState, p: PendingCommand, r: Readings, event?: HistoryBolus): LedgerState {
    switch (p.kind) {
      case 'bolus':
        if (l.bolus?.id === p.id || l.doses.some((d) => d.id === p.id)) return l;
        if (event) return { ...l, doses: [...l.doses, { kind: p.automatic ? 'smb' : 'bolus', date: event.date, units: event.amount, id: p.id }] }; // already finished: the history knows the amount
        return startBolus(l, r.model, { id: p.id, units: p.units, automatic: p.automatic, at: p.sentAt });
      case 'tempBasal': {
        if (p.durationMin === 0) return endBasalSegment(l, p.sentAt);
        const started = startTempBasal(l, { rate: p.rate, durationMin: p.durationMin, at: p.sentAt });
        return r.temp && r.temp.timeRemainingMin > 0 ? started : endBasalSegment(started, Math.min(r.at, p.sentAt + p.durationMin * MIN));
      }
      case 'suspend':
        return suspendDelivery(this.finishActiveBolus(l, r.model, p.sentAt), p.sentAt);
      case 'resume':
        return resumeDelivery(l, p.sentAt);
    }
  }

  /** A suspend stops a running bolus: count what was delivered until `at`. */
  protected finishActiveBolus(l: LedgerState, model: PumpModel, at: Millis): LedgerState {
    return l.bolus ? finishBolus(l, model, at) : l;
  }

  /** Counts a command that was dropped unresolved, conservatively (see `accountUnresolvedPending`). */
  protected accountPending(): void {
    const p = this.record.ledger.pending;
    if (!p) return;
    this.log.warn(`MiniMed: replacing the unresolved ${describePending(p)}, counting it as delivered (conservative)`);
    this.updateLedger((l) => accountUnresolvedPending(l, this.now()));
  }

  // ── PumpDriver-facing state ────────────────────────────────────────────────

  protected snapshotState(): PumpState {
    const r = this.record;
    const now = this.now();
    const seg = r.ledger.basal;
    const tempRunning = seg.kind === 'temp' && now < tempBasalEndsAt(seg);
    const x23 = r.pumpModel !== null && Number(r.pumpModel) % 100 >= 23;
    return {
      reservoirUnits: r.reservoirUnits,
      batteryPercent: r.batteryPercent,
      suspended: r.lastSync === 0 || r.suspended || seg.kind === 'suspended',
      tempBasal: seg.kind === 'temp' && tempRunning ? { rate: seg.rate, startedAt: seg.startedAt, durationMin: seg.durationMin } : null,
      bolusing: r.ledger.bolus !== null || r.ledger.pending?.kind === 'bolus' || r.pumpBolusing,
      bolusIncrement: x23 ? 0.025 : 0.1,
      basalIncrement: x23 ? 0.025 : 0.05,
      lastSync: r.lastSync,
      clockOffsetMs: this.clockOffsetMs,
    };
  }

  protected historyOf(since: Millis) {
    return ledgerHistory(this.record.ledger, this.record.pumpModel, since, this.now());
  }
}
