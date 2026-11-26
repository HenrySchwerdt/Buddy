/**
 * Dose bookkeeping of the Insight driver: the Buddy counterpart of InsightKit's `reportCurrentDoses`
 * / `DoseFactory` (Buddy has no LoopKit `NewPumpEvent`, only `InsulinDose` history).
 *
 * Only insulin the pump confirmed is ever recorded:
 * - a bolus appears with the amount the pump reported as delivered (growing while it runs, taken
 *   from status / `bolusProgress` / the `bolusDelivered` history event) and is edited in place
 *   under the same dose id;
 * - a temp basal appears once the bridge confirmed it and is truncated when it ends early;
 * - a suspend is open-ended until the pump runs again.
 * Everything is pure: functions take a `LedgerState` and return a new one.
 */
import type { InsulinDose } from '@buddy/core';
import { DOSE_RETENTION_MS, MAX_PERSISTED_DOSES, type ActiveTemp, type InsightPersisted, type KnownBolus, type TrackedBolus } from './state';
import { roundToPlaces, type TempSegment } from './dosing-math';

export type LedgerState = Pick<InsightPersisted, 'doses' | 'bolus' | 'temp' | 'suspended' | 'knownBoluses' | 'knownTemps'>;

const MIN = 60_000;
const MAX_KNOWN = 40;

export const bolusDoseId = (requestId: string): string => `insight-bolus-${requestId}`;
export const externalBolusDoseId = (serial: string | null, bolusId: number): string => `insight-${serial ?? 'pump'}-bolus-${bolusId}`;
export const tempDoseIds = (baseId: string, count: number): string[] => Array.from({ length: count }, (_, i) => (count > 1 ? `${baseId}-s${i}` : baseId));
export const tempBaseId = (requestId: string): string => `insight-temp-${requestId}`;

function upsert(doses: readonly InsulinDose[], dose: InsulinDose): InsulinDose[] {
  return [...doses.filter((d) => d.id !== dose.id), dose];
}

const isBolusDose = (d: InsulinDose): d is Extract<InsulinDose, { kind: 'bolus' | 'smb' }> => d.kind === 'bolus' || d.kind === 'smb';

export function bolusDoseOf(b: TrackedBolus, units: number): InsulinDose {
  return { kind: b.automatic ? 'smb' : 'bolus', date: b.sentAt, units: roundToPlaces(units, 4), id: bolusDoseId(b.requestId) };
}

// ── bolus ────────────────────────────────────────────────────────────────────

/** The pump accepted a bolus: track it. Its dose appears with the first delivered amount. */
export function trackBolus<S extends LedgerState>(s: S, b: TrackedBolus): S {
  const withDose = b.delivered > 0 ? upsert(s.doses, bolusDoseOf(b, b.delivered)) : s.doses;
  return { ...s, bolus: b, doses: withDose };
}

/** Progress evidence for the tracked bolus (never moves backwards, never above the programmed amount). */
export function bolusProgress<S extends LedgerState>(s: S, delivered: number, bolusId?: number | null): S {
  const b = s.bolus;
  if (!b || !Number.isFinite(delivered)) return s;
  const next: TrackedBolus = { ...b, delivered: Math.min(Math.max(b.delivered, delivered), b.units), bolusId: b.bolusId ?? bolusId ?? null, missCount: 0 };
  return { ...s, bolus: next, doses: next.delivered > 0 ? upsert(s.doses, bolusDoseOf(next, next.delivered)) : s.doses };
}

export function patchBolus<S extends LedgerState>(s: S, patch: Partial<TrackedBolus>): S {
  return s.bolus ? { ...s, bolus: { ...s.bolus, ...patch } } : s;
}

const withKnown = (known: readonly KnownBolus[], k: KnownBolus): KnownBolus[] => [...known.filter((x) => x.bolusId !== k.bolusId), k].slice(-MAX_KNOWN);

/**
 * Ends the tracked bolus with `units` delivered. `final` is true when the pump itself reported that
 * amount (history event / cancel answer); otherwise it is the best evidence (a later history event
 * may still correct it under the same dose id).
 */
export function finishBolus<S extends LedgerState>(s: S, units: number, final: boolean): S {
  const b = s.bolus;
  if (!b) return s;
  const bounded = Math.min(Math.max(units, 0), b.units);
  const doses = bounded > 0 ? upsert(s.doses, bolusDoseOf(b, bounded)) : s.doses.filter((d) => d.id !== bolusDoseId(b.requestId));
  const knownBoluses = b.bolusId === null ? s.knownBoluses : withKnown(s.knownBoluses, { bolusId: b.bolusId, doseId: bolusDoseId(b.requestId), final });
  return { ...s, bolus: null, doses, knownBoluses };
}

/** A `bolusDelivered` history event for a bolus whose dose is already in the ledger: set the delivered amount. */
export function correctKnownBolus<S extends LedgerState>(s: S, known: KnownBolus, delivered: number): S {
  const dose = s.doses.find((d) => d.id === known.doseId);
  const doses = dose && isBolusDose(dose) ? upsert(s.doses, { ...dose, units: roundToPlaces(delivered, 4) }) : s.doses;
  return { ...s, doses, knownBoluses: withKnown(s.knownBoluses, { ...known, final: true }) };
}

/** A bolus delivered by the pump that this driver did not start (programmed on the pump itself). */
export function recordExternalBolus<S extends LedgerState>(s: S, bolusId: number, doseId: string, start: number, units: number): S {
  if (units <= 0) return { ...s, knownBoluses: withKnown(s.knownBoluses, { bolusId, doseId, final: true }) };
  return {
    ...s,
    doses: upsert(s.doses, { kind: 'bolus', date: start, units: roundToPlaces(units, 4), id: doseId }),
    knownBoluses: withKnown(s.knownBoluses, { bolusId, doseId, final: true }),
  };
}

// ── temp basal ───────────────────────────────────────────────────────────────

/** Truncates the segments of `temp` at `at` (the temp basal ended or was replaced then). */
function truncate(doses: readonly InsulinDose[], temp: ActiveTemp, at: number): InsulinDose[] {
  return doses.map((d) => {
    if (d.kind !== 'tempBasal' || !temp.segmentIds.includes(d.id)) return d;
    if (d.date >= at) return { ...d, date: at, durationMin: 0 };
    if (d.date + d.durationMin * MIN > at) return { ...d, durationMin: roundToPlaces((at - d.date) / MIN, 3) };
    return d;
  });
}

/** A temp basal the bridge confirmed; ends a running one at its start. */
export function startTemp<S extends LedgerState>(s: S, temp: ActiveTemp, segments: readonly TempSegment[]): S {
  const ended = endTemp(s, temp.startedAt);
  const ids = temp.segmentIds;
  let doses = ended.doses;
  segments.forEach((seg, i) => {
    doses = upsert(doses, { kind: 'tempBasal', id: ids[i]!, date: seg.date, rate: seg.rate, durationMin: seg.durationMin });
  });
  return { ...ended, doses, temp };
}

/** The running temp basal (if any) stopped at `at`. */
export function endTemp<S extends LedgerState>(s: S, at: number): S {
  if (!s.temp) return s;
  return { ...s, doses: truncate(s.doses, s.temp, at), temp: null };
}

/** The temp basal this driver set and that has not ended yet. */
export function activeTemp<S extends LedgerState>(s: S, now: number): ActiveTemp | null {
  const t = s.temp;
  return t && now < t.startedAt + t.durationMin * MIN ? t : null;
}

/** A temp basal taken from the pump's own history (not set by this driver). */
export function recordExternalTemp<S extends LedgerState>(s: S, baseId: string, segments: readonly TempSegment[]): S {
  if (s.knownTemps.includes(baseId)) return s;
  const ids = tempDoseIds(baseId, segments.length);
  let doses = s.doses;
  segments.forEach((seg, i) => {
    doses = upsert(doses, { kind: 'tempBasal', id: ids[i]!, date: seg.date, rate: seg.rate, durationMin: seg.durationMin });
  });
  return { ...s, doses, knownTemps: [...s.knownTemps, baseId].slice(-MAX_KNOWN) };
}

// ── suspend ──────────────────────────────────────────────────────────────────

/** Delivery stopped at `at` (a temp basal ends there). No-op if already suspended. */
export function suspend<S extends LedgerState>(s: S, at: number, id: string): S {
  if (s.suspended) return s;
  const ended = endTemp(s, at);
  return { ...ended, doses: upsert(ended.doses, { kind: 'suspend', id, date: at, durationMin: 0 }), suspended: { doseId: id, since: at } };
}

/** Delivery resumed on schedule at `at`. No-op if not suspended. */
export function resume<S extends LedgerState>(s: S, at: number): S {
  const sus = s.suspended;
  if (!sus) return s;
  const durationMin = roundToPlaces(Math.max(0, at - sus.since) / MIN, 3);
  return { ...s, doses: s.doses.map((d) => (d.id === sus.doseId && d.kind === 'suspend' ? { ...d, durationMin } : d)), suspended: null };
}

// ── reading ──────────────────────────────────────────────────────────────────

/** Delivered doses with `date >= since`; an open suspend reports its duration so far. */
export function historyOf<S extends LedgerState>(s: S, since: number, now: number): InsulinDose[] {
  const sus = s.suspended;
  return s.doses
    .map((d): InsulinDose => (sus && d.kind === 'suspend' && d.id === sus.doseId ? { ...d, durationMin: roundToPlaces(Math.max(0, now - d.date) / MIN, 3) } : d))
    .filter((d) => d.date >= since)
    .sort((a, b) => a.date - b.date);
}

/** Drops doses older than the retention window (never the ones still referenced by a live record). */
export function prune<S extends LedgerState>(s: S, now: number): S {
  const keepAfter = now - DOSE_RETENTION_MS;
  const live = new Set<string>([...(s.temp?.segmentIds ?? []), ...(s.bolus ? [bolusDoseId(s.bolus.requestId)] : []), ...(s.suspended ? [s.suspended.doseId] : [])]);
  const doses = s.doses.filter((d) => d.date >= keepAfter || live.has(d.id)).slice(-MAX_PERSISTED_DOSES);
  return doses.length === s.doses.length ? s : { ...s, doses };
}
