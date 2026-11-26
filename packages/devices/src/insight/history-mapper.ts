/**
 * Maps pump history events onto the dose ledger (port of InsightKit `HistoryMapper`): delivered
 * boluses (with the amount the pump says it delivered), ended temp basals and the matching of both
 * against what this driver started itself, so no insulin is ever counted twice.
 */
import type { Millis } from '@buddy/core';
import { INSIGHT_SPEC, tempSegments, type HourlyRates } from './dosing-math';
import * as L from './ledger';
import { eventDate, eventInt, eventNumber, type HistoryEvent } from './models';
import type { InsightPersisted } from './state';

/** Plausibility limit for a bolus read from history. */
export const MAX_PLAUSIBLE_BOLUS = 50;
/** A history event matches a bolus we started if it began within this window around our start. */
const BOLUS_MATCH_BEFORE_MS = 2 * 60_000;
const BOLUS_MATCH_AFTER_MS = 10 * 60_000;
const TEMP_MATCH_MS = 180_000;
const MIN = 60_000;

export interface MapContext {
  /** The configured profile (`null`: external temp basals cannot be costed and are skipped). */
  readonly profile: HourlyRates | null;
  readonly utcOffsetSeconds: number;
  readonly driftMs: number;
}

export interface MapResult {
  readonly state: InsightPersisted;
  /** The event could not be read plausibly: the history cursor must not move past it. */
  readonly unreadable: boolean;
  /** The event belongs to a command whose outcome is unknown. */
  readonly matchedPending?: boolean;
}

function matchesTracked(b: NonNullable<InsightPersisted['bolus']>, e: HistoryEvent, programmed: number | null): boolean {
  const id = eventInt(e, 'bolusId');
  if (b.bolusId !== null && id !== null) return b.bolusId === id;
  if (programmed === null || Math.abs(programmed - b.units) >= 0.005) return false;
  const start = eventDate(e, 'start') ?? e.time;
  return start >= b.sentAt - BOLUS_MATCH_BEFORE_MS && start <= b.sentAt + BOLUS_MATCH_AFTER_MS;
}

const plausible = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v >= 0 && v <= MAX_PLAUSIBLE_BOLUS ? v : null);

export function applyDeliveredBolus(st: InsightPersisted, e: HistoryEvent): MapResult {
  const programmed = plausible(eventNumber(e, 'programmed') ?? eventNumber(e, 'amount'));
  const delivered = plausible(eventNumber(e, 'delivered'));
  const bolusId = eventInt(e, 'bolusId');
  let unreadable = false;
  let counted: number;
  if (programmed !== null && delivered !== null && delivered <= programmed + 0.01) counted = delivered;
  else {
    // When the numbers do not add up, take the larger (more insulin on board).
    unreadable = true;
    counted = Math.max(programmed ?? 0, delivered ?? 0);
  }
  if (!(counted > 0) && !(programmed !== null && delivered !== null)) return { state: st, unreadable: true };

  const start = eventDate(e, 'start') ?? e.time;
  const tracked = st.bolus && matchesTracked(st.bolus, e, programmed) ? st.bolus : null;
  if (tracked) {
    const withId = bolusId !== null && tracked.bolusId === null ? L.patchBolus(st, { bolusId }) : st;
    return { state: L.finishBolus(withId, counted, true), unreadable };
  }
  const known = bolusId !== null ? st.knownBoluses.find((k) => k.bolusId === bolusId) : undefined;
  if (known) return { state: known.final ? st : L.correctKnownBolus(st, known, counted), unreadable };

  // An uncertain bolus of ours acts as the candidate that a matching history event belongs to.
  const p = st.pending;
  if (p && p.kind === 'bolus' && p.isUncertain && p.units !== undefined && programmed !== null && Math.abs(programmed - p.units) < 0.005 && start >= p.sentAt - BOLUS_MATCH_BEFORE_MS && start <= p.sentAt + BOLUS_MATCH_AFTER_MS) {
    const synthetic = { requestId: p.requestId, units: p.units, bolusId, sentAt: p.sentAt, acceptedAt: p.sentAt, automatic: p.automatic, delivered: 0, missCount: 0, stopped: false };
    return { state: L.finishBolus(L.trackBolus(st, synthetic), counted, true), unreadable, matchedPending: true };
  }
  const doseId = bolusId !== null ? L.externalBolusDoseId(st.pumpSerial, bolusId) : `insight-${st.pumpSerial ?? 'pump'}-bolus-seq${e.seq}`;
  return { state: L.recordExternalBolus(st, bolusId ?? -e.seq, doseId, start, counted), unreadable };
}

export function applyTbrEnd(st: InsightPersisted, e: HistoryEvent, ctx: MapContext): MapResult {
  const percent = eventInt(e, 'percent');
  const minutes = eventInt(e, 'duration');
  if (percent === null || minutes === null || percent < 0 || percent > INSIGHT_SPEC.tbrMaxPercent || minutes < 0 || minutes > INSIGHT_SPEC.tbrMaxMinutes) return { state: st, unreadable: true };
  if (minutes === 0) return { state: st, unreadable: false };
  const end: Millis = e.time;
  const start = end - minutes * MIN;
  // Ours: the pump says when it really ended (possibly earlier than planned).
  const t = st.temp;
  if (t && t.percent === percent && Math.abs(t.startedAt - start) < TEMP_MATCH_MS + Math.abs(ctx.driftMs)) {
    return { state: L.endTemp(st, Math.min(end, t.startedAt + t.durationMin * MIN)), unreadable: false };
  }
  // A temp basal we set that already ended (and was cleared) is in the ledger under its own id.
  if (st.doses.some((d) => d.kind === 'tempBasal' && d.id.startsWith('insight-temp-') && Math.abs(d.date - start) < TEMP_MATCH_MS)) return { state: st, unreadable: false };
  if (!ctx.profile) return { state: st, unreadable: false }; // cannot cost it without the schedule
  const baseId = `insight-${st.pumpSerial ?? 'pump'}-tbr-${Math.round(start / 1000)}-${percent}`;
  return { state: L.recordExternalTemp(st, baseId, tempSegments(percent, start, minutes, ctx.profile, ctx.utcOffsetSeconds, 0)), unreadable: false };
}
