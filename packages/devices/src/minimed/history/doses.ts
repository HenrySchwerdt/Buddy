/**
 * Pump history events as doses: the insulin-relevant part of `DoseStore.swift`
 * (`Collection<TimestampedHistoryEvent>.pumpEvents(from:)`) of MinimedKit (migrated from
 * ps2/rileylink_ios, MIT License, (c) LoopKit Authors).
 *
 *  - a bolus record becomes a bolus with the amount the pump says it delivered;
 *  - an absolute temp basal record is paired with the duration record that carries the same
 *    timestamp (0 minutes is a cancel); percent temp basals cannot be turned into units;
 *  - a suspend record starts a suspend dose that the next resume (or the end of the list) closes.
 * The id of a dose is derived from the record, so importing the same record twice is harmless.
 */
import { hex, type InsulinDose } from '@buddy/core';
import type { TimestampedHistoryEvent } from './events';

const MIN = 60_000;

export const historyDoseId = (e: TimestampedHistoryEvent): string => `minimed-h-${e.date}-${hex(e.event.rawData)}`;

export interface HistoryBolus {
  readonly id: string;
  /** when the bolus started, ms */
  readonly date: number;
  /** units the pump delivered */
  readonly amount: number;
  /** units that were programmed */
  readonly programmed: number;
  readonly wasRemotelyTriggered: boolean;
}

export function bolusesFromHistory(events: readonly TimestampedHistoryEvent[]): HistoryBolus[] {
  const out: HistoryBolus[] = [];
  for (const e of events) {
    if (e.event.kind === 'bolus') out.push({ id: historyDoseId(e), date: e.date, amount: e.event.amount, programmed: e.event.programmed, wasRemotelyTriggered: e.event.wasRemotelyTriggered });
  }
  return out;
}

export interface HistoryTempBasal {
  readonly date: number;
  readonly rate: number;
  readonly durationMin: number;
}

/** Absolute temp basals with the duration record of the same timestamp (the rate record comes first in a page). */
export function tempBasalsFromHistory(events: readonly TimestampedHistoryEvent[]): HistoryTempBasal[] {
  const out: HistoryTempBasal[] = [];
  let last: { date: number; rate: number } | null = null;
  for (const e of events) {
    if (e.event.kind === 'tempBasal') {
      last = e.event.rateType === 'absolute' ? { date: e.date, rate: e.event.rate } : null;
    } else if (e.event.kind === 'tempBasalDuration' && last && last.date === e.date) {
      out.push({ date: e.date, rate: last.rate, durationMin: e.event.durationMin });
    }
  }
  return out;
}

/** Everything the history says about delivered insulin and suspended time, as Buddy doses. */
export function dosesFromHistory(events: readonly TimestampedHistoryEvent[]): InsulinDose[] {
  const doses: InsulinDose[] = [];
  for (const b of bolusesFromHistory(events)) if (b.amount > 0) doses.push({ kind: 'bolus', date: b.date, units: b.amount, id: b.id });
  for (const t of tempBasalsFromHistory(events)) doses.push({ kind: 'tempBasal', date: t.date, rate: t.rate, durationMin: t.durationMin, id: `minimed-temp-${t.date}` });
  let openSuspend: { date: number; id: string } | null = null;
  for (const e of events) {
    // a rewind stops delivery until the first prime, like a suspend
    if ((e.event.kind === 'suspend' || e.event.kind === 'rewind') && !openSuspend) openSuspend = { date: e.date, id: historyDoseId(e) };
    else if ((e.event.kind === 'resume' || e.event.kind === 'prime') && openSuspend) {
      doses.push({ kind: 'suspend', date: openSuspend.date, durationMin: Math.max(0, (e.date - openSuspend.date) / MIN), id: openSuspend.id });
      openSuspend = null;
    }
  }
  return doses.sort((a, b) => a.date - b.date);
}
