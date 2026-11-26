/**
 * Dose bookkeeping of the MiniMed driver: Buddy's `InsulinDose` history in place of the LoopKit
 * `UnfinalizedDose` / `NewPumpEvent` plumbing of MinimedKit (`UnfinalizedDose.swift`,
 * `MinimedPumpManager.swift`; migrated from ps2/rileylink_ios, MIT License, (c) LoopKit Authors).
 * Modelled on the ledger of the Omnipod drivers; all functions are pure.
 *
 * What differs from a pod: a MiniMed cannot report how much of a bolus it has delivered, only
 * whether it is still bolusing. So
 *  - a running bolus counts with the amount the pump's delivery speed implies for the time since
 *    the command was acknowledged (`estimateBolusProgress`), never more than programmed;
 *  - a finished bolus keeps that estimate until the pump history shows the real amount
 *    (`unverified` entries), then the history value replaces it;
 *  - a bolus or temp basal appears only after the pump confirmed the command.
 */
import { newId, type InsulinDose, type Millis } from '@buddy/core';
import { estimateBolusProgress, bolusDeliveryTimeMs, type PumpModel } from './models';

const MIN = 60_000;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * MIN;
const HISTORY_MAX_ENTRIES = 2000;
const UNVERIFIED_MAX_AGE_MS = 6 * 60 * MIN;

export type PendingCommand =
  | { readonly kind: 'bolus'; readonly id: string; readonly units: number; readonly automatic: boolean; readonly sentAt: Millis }
  /** `rate` 0 for `durationMin` 0 is a cancel. `prior*` is what the pump ran before. */
  | { readonly kind: 'tempBasal'; readonly rate: number; readonly durationMin: number; readonly sentAt: Millis; readonly priorRate: number | null; readonly priorRemainingMin: number }
  | { readonly kind: 'suspend'; readonly sentAt: Millis }
  | { readonly kind: 'resume'; readonly sentAt: Millis };

export interface ActiveBolus {
  readonly id: string;
  readonly requested: number;
  readonly automatic: boolean;
  /** when the pump acknowledged the command */
  readonly sentAt: Millis;
  readonly durationMs: number;
}

/** A finished bolus whose amount is still an estimate. */
export interface UnverifiedBolus {
  readonly id: string;
  readonly requested: number;
  readonly date: Millis;
  readonly finishedAt: Millis;
}

export type BasalSegment =
  | { readonly kind: 'scheduled' }
  | { readonly kind: 'temp'; readonly doseId: string; readonly rate: number; readonly startedAt: Millis; readonly durationMin: number }
  | { readonly kind: 'suspended'; readonly doseId: string; readonly since: Millis };

export interface LedgerState {
  readonly doses: readonly InsulinDose[];
  readonly bolus: ActiveBolus | null;
  readonly basal: BasalSegment;
  /** a command whose outcome is not known yet */
  readonly pending: PendingCommand | null;
  readonly unverified: readonly UnverifiedBolus[];
}

export const emptyLedger = (): LedgerState => ({ doses: [], bolus: null, basal: { kind: 'scheduled' }, pending: null, unverified: [] });

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const upsert = (doses: readonly InsulinDose[], dose: InsulinDose): InsulinDose[] => [...doses.filter((d) => d.id !== dose.id), dose];

export function pruneLedger(s: LedgerState, now: Millis): LedgerState {
  const keepAfter = now - HISTORY_RETENTION_MS;
  return { ...s, doses: s.doses.filter((d) => d.date >= keepAfter).slice(-HISTORY_MAX_ENTRIES), unverified: s.unverified.filter((u) => now - u.finishedAt <= UNVERIFIED_MAX_AGE_MS) };
}

/** Units of the running bolus delivered by `now`, by the pump's delivery speed. */
export const activeBolusDelivered = (model: PumpModel, b: ActiveBolus, now: Millis): number =>
  round3(estimateBolusProgress(model, Math.max(0, now - b.sentAt), b.requested).deliveredUnits);

export const bolusEndsAt = (b: ActiveBolus): Millis => b.sentAt + b.durationMs;

/** Delivered doses with `date >= since`; the running bolus and an open suspend are included. */
export function ledgerHistory(s: LedgerState, model: PumpModel | null, since: Millis, now: Millis): InsulinDose[] {
  const seg = s.basal;
  const out = s.doses
    .map((d): InsulinDose => (seg.kind === 'suspended' && d.kind === 'suspend' && d.id === seg.doseId ? { ...d, durationMin: round3(Math.max(0, now - d.date) / MIN) } : d))
    .filter((d) => d.date >= since);
  const b = s.bolus;
  if (b && model && b.sentAt >= since) {
    const delivered = activeBolusDelivered(model, b, now);
    if (delivered > 0) out.push({ kind: b.automatic ? 'smb' : 'bolus', date: b.sentAt, units: delivered, id: b.id });
  }
  return out.sort((a, c) => a.date - c.date);
}

// ── bolus ───────────────────────────────────────────────────────────────────

export function startBolus(s: LedgerState, model: PumpModel, p: { id: string; units: number; automatic: boolean; at: Millis }): LedgerState {
  if (s.bolus) throw new Error('A bolus is already in progress');
  return { ...s, bolus: { id: p.id, requested: p.units, automatic: p.automatic, sentAt: p.at, durationMs: bolusDeliveryTimeMs(model, p.units) } };
}

/**
 * The bolus is over at `at` (finished, cancelled by a suspend, or stopped at the pump). It is
 * recorded with the delivery estimate for `at` and stays "unverified" until the history confirms it.
 */
export function finishBolus(s: LedgerState, model: PumpModel, at: Millis): LedgerState {
  const b = s.bolus;
  if (!b) return s;
  const delivered = activeBolusDelivered(model, b, Math.min(at, bolusEndsAt(b)));
  if (delivered <= 0) return { ...s, bolus: null };
  const dose: InsulinDose = { kind: b.automatic ? 'smb' : 'bolus', date: b.sentAt, units: delivered, id: b.id };
  return { ...s, bolus: null, doses: upsert(s.doses, dose), unverified: [...s.unverified, { id: b.id, requested: b.requested, date: b.sentAt, finishedAt: at }] };
}

/** The history showed what the pump really delivered for an estimated bolus. */
export function verifyBolus(s: LedgerState, id: string, units: number): LedgerState {
  const doses = s.doses.map((d) => (d.id === id && (d.kind === 'bolus' || d.kind === 'smb') ? { ...d, units: round3(units) } : d)).filter((d) => !((d.kind === 'bolus' || d.kind === 'smb') && d.id === id && d.units <= 0));
  return { ...s, doses, unverified: s.unverified.filter((u) => u.id !== id) };
}

/** Adds a dose the pump reported that Buddy did not issue (a bolus from the pump's buttons). */
export const importDose = (s: LedgerState, dose: InsulinDose): LedgerState => (s.doses.some((d) => d.id === dose.id) ? s : { ...s, doses: [...s.doses, dose] });

// ── temp basal / suspend ────────────────────────────────────────────────────

export function startTempBasal(s: LedgerState, p: { rate: number; durationMin: number; at: Millis }): LedgerState {
  const ended = endBasalSegment(s, p.at);
  const id = newId('minimed-temp');
  const dose: InsulinDose = { kind: 'tempBasal', date: p.at, rate: p.rate, durationMin: p.durationMin, id };
  return { ...ended, doses: upsert(ended.doses, dose), basal: { kind: 'temp', doseId: id, rate: p.rate, startedAt: p.at, durationMin: p.durationMin } };
}

/** Ends a running temp basal (truncating its dose at `at`) or an open suspend; basal returns to scheduled. */
export function endBasalSegment(s: LedgerState, at: Millis): LedgerState {
  const seg = s.basal;
  if (seg.kind === 'temp') {
    const elapsedMin = Math.max(0, Math.min(seg.durationMin, round3((at - seg.startedAt) / MIN)));
    return { ...s, doses: s.doses.map((d) => (d.id === seg.doseId && d.kind === 'tempBasal' ? { ...d, durationMin: elapsedMin } : d)), basal: { kind: 'scheduled' } };
  }
  if (seg.kind === 'suspended') {
    const durationMin = round3(Math.max(0, at - seg.since) / MIN);
    return { ...s, doses: s.doses.map((d) => (d.id === seg.doseId && d.kind === 'suspend' ? { ...d, durationMin } : d)), basal: { kind: 'scheduled' } };
  }
  return s;
}

export function suspendDelivery(s: LedgerState, at: Millis): LedgerState {
  if (s.basal.kind === 'suspended') return s;
  const ended = endBasalSegment(s, at);
  const id = newId('minimed-suspend');
  return { ...ended, doses: upsert(ended.doses, { kind: 'suspend', date: at, durationMin: 0, id }), basal: { kind: 'suspended', doseId: id, since: at } };
}

export const resumeDelivery = (s: LedgerState, at: Millis): LedgerState => (s.basal.kind === 'suspended' ? endBasalSegment(s, at) : s);

export const tempBasalEndsAt = (seg: Extract<BasalSegment, { kind: 'temp' }>): Millis => seg.startedAt + seg.durationMin * MIN;

// ── unresolved pending commands ─────────────────────────────────────────────

/**
 * Accounts for a pending command that is replaced or dropped without the pump having settled it.
 * Conservative (over-estimating IOB is the safe side): a pending bolus counts with the full
 * programmed amount, a pending temp basal as running from its send time until `at`. Cancels,
 * suspends and resumes leave no insulin to account for.
 */
export function accountUnresolvedPending(s: LedgerState, at: Millis): LedgerState {
  const p = s.pending;
  if (!p) return s;
  const cleared: LedgerState = { ...s, pending: null };
  if (p.kind === 'bolus') {
    if (cleared.bolus?.id === p.id || cleared.doses.some((d) => d.id === p.id)) return cleared;
    return {
      ...cleared,
      doses: upsert(cleared.doses, { kind: p.automatic ? 'smb' : 'bolus', date: p.sentAt, units: round3(p.units), id: p.id }),
      unverified: [...cleared.unverified, { id: p.id, requested: p.units, date: p.sentAt, finishedAt: at }],
    };
  }
  if (p.kind === 'tempBasal' && p.durationMin > 0) return endBasalSegment(startTempBasal(cleared, { rate: p.rate, durationMin: p.durationMin, at: p.sentAt }), Math.max(p.sentAt, at));
  return cleared;
}

export const describePending = (p: PendingCommand): string => {
  switch (p.kind) {
    case 'bolus':
      return `${p.units.toFixed(3)} U bolus`;
    case 'tempBasal':
      return p.durationMin === 0 ? 'cancel temp basal' : `${p.rate} U/h temp basal`;
    case 'suspend':
      return 'suspend';
    case 'resume':
      return 'resume';
  }
};
