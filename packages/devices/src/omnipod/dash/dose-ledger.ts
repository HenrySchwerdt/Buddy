/**
 * Dose bookkeeping of the DASH driver. Replaces the LoopKit `UnfinalizedDose` / `NewPumpEvent`
 * plumbing of OmnipodKit (`OmnipodCommon/UnfinalizedDose.swift`, `PodState.swift`; MIT License,
 * (c) LoopKit Authors) with Buddy's `InsulinDose` history.
 *
 * Rules (IOB is computed from `history()`):
 *  - a bolus is only ever reported with what the POD confirmed as delivered
 *    (`requested - bolusNotDelivered` of the last status that reached us);
 *  - a bolus or temp basal appears only after the pod confirmed the command;
 *  - a temp basal that ends early (cancel, suspend, fault) is truncated, so IOB stays correct.
 * All functions are pure: they return a new {@link LedgerState}.
 */
import type { InsulinDose, Millis } from '@buddy/core';
import { newId } from '@buddy/core';
import type { PendingCommand } from './pending';

const MIN = 60_000;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * MIN;
const HISTORY_MAX_ENTRIES = 2000;

export interface ActiveBolus {
  readonly id: string;
  readonly requested: number;
  /** Units the pod confirmed as delivered so far. */
  readonly delivered: number;
  readonly automatic: boolean;
  readonly sentAt: Millis;
}

export type BasalSegment =
  | { readonly kind: 'scheduled' }
  | { readonly kind: 'temp'; readonly doseId: string; readonly rate: number; readonly startedAt: Millis; readonly durationMin: number }
  | { readonly kind: 'suspended'; readonly doseId: string; readonly since: Millis };

export interface LedgerState {
  readonly doses: readonly InsulinDose[];
  readonly bolus: ActiveBolus | null;
  readonly basal: BasalSegment;
  /** A programming command whose outcome is not known yet. */
  readonly pending: PendingCommand | null;
}

export const emptyLedger = (): LedgerState => ({ doses: [], bolus: null, basal: { kind: 'scheduled' }, pending: null });

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const upsert = (doses: readonly InsulinDose[], dose: InsulinDose): InsulinDose[] => [...doses.filter((d) => d.id !== dose.id), dose];

export function pruneLedger(s: LedgerState, now: Millis): LedgerState {
  const keepAfter = now - HISTORY_RETENTION_MS;
  return { ...s, doses: s.doses.filter((d) => d.date >= keepAfter).slice(-HISTORY_MAX_ENTRIES) };
}

/** Delivered doses with `date >= since`; the running bolus and an open suspend are included. */
export function ledgerHistory(s: LedgerState, since: Millis, now: Millis): InsulinDose[] {
  const seg = s.basal;
  const out = s.doses
    .map((d): InsulinDose => (seg.kind === 'suspended' && d.kind === 'suspend' && d.id === seg.doseId ? { ...d, durationMin: round3(Math.max(0, now - d.date) / MIN) } : d))
    .filter((d) => d.date >= since);
  const b = s.bolus;
  if (b && b.delivered > 0 && b.sentAt >= since) out.push({ kind: b.automatic ? 'smb' : 'bolus', date: b.sentAt, units: b.delivered, id: b.id });
  return out.sort((a, c) => a.date - c.date);
}

// ── bolus ───────────────────────────────────────────────────────────────────

export function startBolus(s: LedgerState, p: { requested: number; automatic: boolean; at: Millis; delivered: number; id?: string }): LedgerState {
  if (s.bolus) throw new Error('A bolus is already in progress');
  const id = p.id ?? newId('omnipod-bolus');
  return { ...s, bolus: { id, requested: p.requested, delivered: Math.min(p.requested, p.delivered), automatic: p.automatic, sentAt: p.at } };
}

/** What the pod reports for the running bolus. Never moves `delivered` backwards. */
export function updateBolusFromPod(s: LedgerState, deliveredByPod: number, finished: boolean): LedgerState {
  const b = s.bolus;
  if (!b) return s;
  const delivered = round3(Math.max(b.delivered, Math.min(b.requested, deliveredByPod)));
  if (!finished) return { ...s, bolus: { ...b, delivered } };
  return closeBolus({ ...s, bolus: { ...b, delivered } });
}

/** The bolus is over (finished, cancelled or the pod faulted) with `delivered` as the pod's final count. */
export function finishBolus(s: LedgerState, finalDelivered: number): LedgerState {
  const b = s.bolus;
  if (!b) return s;
  return closeBolus({ ...s, bolus: { ...b, delivered: round3(Math.max(0, Math.min(b.requested, finalDelivered))) } });
}

function closeBolus(s: LedgerState): LedgerState {
  const b = s.bolus;
  if (!b) return s;
  if (b.delivered <= 0) return { ...s, bolus: null };
  const dose: InsulinDose = { kind: b.automatic ? 'smb' : 'bolus', date: b.sentAt, units: b.delivered, id: b.id };
  return { ...s, bolus: null, doses: upsert(s.doses, dose) };
}

// ── temp basal / suspend ────────────────────────────────────────────────────

export function startTempBasal(s: LedgerState, p: { rate: number; durationMin: number; at: Millis }): LedgerState {
  const ended = endBasalSegment(s, p.at);
  const id = newId('omnipod-temp');
  const dose: InsulinDose = { kind: 'tempBasal', date: p.at, rate: p.rate, durationMin: p.durationMin, id };
  return { ...ended, doses: upsert(ended.doses, dose), basal: { kind: 'temp', doseId: id, rate: p.rate, startedAt: p.at, durationMin: p.durationMin } };
}

/** Ends a running temp basal (truncating its dose at `at`) or an open suspend; basal returns to scheduled. */
export function endBasalSegment(s: LedgerState, at: Millis): LedgerState {
  const seg = s.basal;
  if (seg.kind === 'temp') {
    const elapsedMin = Math.max(0, Math.min(seg.durationMin, round3((at - seg.startedAt) / MIN)));
    const doses = s.doses.map((d) => (d.id === seg.doseId && d.kind === 'tempBasal' ? { ...d, durationMin: elapsedMin } : d));
    return { ...s, doses, basal: { kind: 'scheduled' } };
  }
  if (seg.kind === 'suspended') {
    const durationMin = round3(Math.max(0, at - seg.since) / MIN);
    const doses = s.doses.map((d) => (d.id === seg.doseId && d.kind === 'suspend' ? { ...d, durationMin } : d));
    return { ...s, doses, basal: { kind: 'scheduled' } };
  }
  return s;
}

export function suspendDelivery(s: LedgerState, at: Millis): LedgerState {
  if (s.basal.kind === 'suspended') return s;
  const ended = endBasalSegment(s, at);
  const id = newId('omnipod-suspend');
  const dose: InsulinDose = { kind: 'suspend', date: at, durationMin: 0, id };
  return { ...ended, doses: upsert(ended.doses, dose), basal: { kind: 'suspended', doseId: id, since: at } };
}

export const resumeDelivery = (s: LedgerState, at: Millis): LedgerState => (s.basal.kind === 'suspended' ? endBasalSegment(s, at) : s);

/** The temp basal ran its course. */
export const tempBasalExpiredAt = (s: LedgerState, at: Millis): boolean =>
  s.basal.kind === 'temp' && at >= s.basal.startedAt + s.basal.durationMin * MIN;

// ── unresolved pending commands ─────────────────────────────────────────────

/**
 * Accounts for a pending command that is replaced or cleared without the pod having settled it.
 * Conservative (over-estimating IOB is the safe side): a pending bolus counts with what the pod
 * reported as delivered (`deliveredByPod`) or, without such a report, the full requested amount;
 * a pending temp basal counts as running from its send time until `at`. Cancels and basal programs
 * leave no insulin to account for. A command the ledger already holds is not counted twice.
 */
export function accountUnresolvedPending(s: LedgerState, at: Millis, deliveredByPod?: number): LedgerState {
  const p = s.pending;
  if (!p) return s;
  const cleared: LedgerState = { ...s, pending: null };
  if (p.kind === 'bolus') {
    if (cleared.bolus?.id === p.id || cleared.doses.some((d) => d.id === p.id)) return cleared;
    const units = round3(Math.max(0, Math.min(p.units, deliveredByPod ?? p.units)));
    if (units <= 0) return cleared;
    return { ...cleared, doses: upsert(cleared.doses, { kind: p.automatic ? 'smb' : 'bolus', date: p.sentAt, units, id: p.id }) };
  }
  if (p.kind === 'tempBasal') return endBasalSegment(startTempBasal(cleared, { rate: p.rate, durationMin: p.durationMin, at: p.sentAt }), Math.max(p.sentAt, at));
  return cleared;
}
