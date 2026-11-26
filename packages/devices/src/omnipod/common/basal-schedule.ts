/**
 * Basal schedule. Port of `OmnipodCommon/BasalSchedule.swift` (and the `Schedule` adapter of
 * `BasalSchedule+LoopKit.swift`) from OmnipodKit (MIT License, (c) LoopKit Authors).
 * Offsets are seconds after local midnight.
 */
import type { Schedule } from '@buddy/core';
import { HOUR, MINUTE, POD } from './pod-constants';
import { roundToSupportedBasalRate } from './insulin-table';

export interface BasalScheduleEntry {
  readonly rate: number;
  /** seconds after midnight */
  readonly startTime: number;
}

export interface BasalSchedule {
  readonly entries: readonly BasalScheduleEntry[];
}

/** A rate of 0 on a pod without a true zero basal is raised to one pulse per hour (as OmnipodKit does). */
export function makeBasalEntry(rate: number, startTime: number, zeroBasalRate: number): BasalScheduleEntry {
  let rounded = roundToSupportedBasalRate(rate);
  if (rounded === 0 && zeroBasalRate === 0) rounded = POD.pulseSize;
  return { rate: rounded, startTime };
}

export function basalScheduleFromBuddy(schedule: Schedule, zeroBasalRate: number): BasalSchedule {
  if (schedule.length === 0) throw new Error('Basal schedule is empty');
  const sorted = [...schedule].sort((a, b) => a.startMinute - b.startMinute);
  if (sorted[0]!.startMinute !== 0) throw new Error('Basal schedule must start at 00:00');
  if (sorted.length > POD.maximumBasalScheduleEntryCount) throw new Error(`Basal schedule has more than ${POD.maximumBasalScheduleEntryCount} entries`);
  for (const e of sorted) {
    if (!(e.value >= 0 && e.value <= POD.maximumBasalUnitsPerHour)) throw new Error(`Basal rate ${e.value} U/h is outside 0..${POD.maximumBasalUnitsPerHour}`);
    if (e.startMinute % 30 !== 0 || e.startMinute < 0 || e.startMinute >= 24 * 60) throw new Error('Basal schedule entries must start on half hours within one day');
  }
  return { entries: sorted.map((e) => makeBasalEntry(e.value, e.startMinute * MINUTE, zeroBasalRate)) };
}

export function rateAt(schedule: BasalSchedule, offsetSeconds: number): number {
  if (!(offsetSeconds >= 0 && offsetSeconds < 24 * HOUR)) throw new Error('Schedule offset out of bounds');
  for (let i = schedule.entries.length - 1; i >= 0; i--) {
    const e = schedule.entries[i]!;
    if (e.startTime <= offsetSeconds) return e.rate;
  }
  throw new Error('Schedule incomplete');
}

/** Merges neighbouring entries that have the same rate. */
export function adjacentEqualRatesMerged(entries: readonly BasalScheduleEntry[]): BasalScheduleEntry[] {
  const out: BasalScheduleEntry[] = [];
  let last: number | null = null;
  for (const e of entries) {
    if (e.rate !== last) out.push(e);
    last = e.rate;
  }
  return out;
}

/** Duration of each entry up to the next one (or midnight), in order. */
export function entryDurations(entries: readonly BasalScheduleEntry[]): { rate: number; duration: number; startTime: number }[] {
  return entries.map((e, i) => ({
    rate: e.rate,
    startTime: e.startTime,
    duration: (i + 1 < entries.length ? entries[i + 1]!.startTime : 24 * HOUR) - e.startTime,
  }));
}
