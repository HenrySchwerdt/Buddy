/**
 * TypeScript port of `Messages/Models/BasalSchedule.swift` from MinimedKit (migrated from
 * ps2/rileylink_ios, MIT License, (c) LoopKit Authors): the basal profile as the pump stores it,
 * 3 bytes per entry (little-endian rate in 1/40 U/h, start time in 30 minute steps).
 */
import type { Bytes, Schedule } from '@buddy/core';

export interface BasalScheduleEntry {
  readonly index: number;
  /** minutes after midnight */
  readonly startMinute: number;
  /** U/h */
  readonly rate: number;
}

export interface BasalSchedule {
  readonly entries: readonly BasalScheduleEntry[];
}

export const BASAL_SCHEDULE_RAW_LENGTH = 192;

/** Null for an empty schedule or one that does not start with a valid entry. Stops at the first entry that does not advance in time. */
export function decodeBasalSchedule(raw: Bytes): BasalSchedule | null {
  const entries: BasalScheduleEntry[] = [];
  for (let index = 0, offset = 0; offset + 3 < raw.length; index++, offset += 3) {
    const startMinute = raw[offset + 2]! * 30;
    if (startMinute >= 24 * 60) break; // 0x3f marks the end
    const last = entries[entries.length - 1];
    if (last && last.startMinute >= startMinute) break;
    entries.push({ index, startMinute, rate: (raw[offset]! | (raw[offset + 1]! << 8)) / 40 });
  }
  return entries.length > 0 ? { entries } : null;
}

/** The schedule as Buddy's `Schedule` (minutes after midnight, U/h). */
export const basalScheduleToBuddy = (s: BasalSchedule): Schedule => s.entries.map((e) => ({ startMinute: e.startMinute, value: e.rate }));

/** The rate of the entry in force at `minuteOfDay`. */
export function basalRateAt(s: BasalSchedule, minuteOfDay: number): number {
  let rate = s.entries[0]!.rate;
  for (const e of s.entries) if (e.startMinute <= minuteOfDay) rate = e.rate;
  return rate;
}

/** The 192 byte profile the pump takes (`BasalSchedule.rawValue`); an empty schedule is the "clear" code. */
export function encodeBasalSchedule(s: BasalSchedule): Bytes {
  const out = new Uint8Array(BASAL_SCHEDULE_RAW_LENGTH);
  s.entries.forEach((e, i) => {
    const strokes = Math.min(0xffff, Math.max(0, Math.trunc(e.rate * 40 + 1e-9)));
    out[i * 3] = strokes & 0xff;
    out[i * 3 + 1] = strokes >> 8;
    out[i * 3 + 2] = Math.min(0xff, Math.trunc(e.startMinute / 30));
  });
  if (s.entries.length === 0) out[2] = 0x3f;
  return out;
}
