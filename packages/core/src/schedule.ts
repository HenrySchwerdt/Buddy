import type { Millis, Schedule } from './types';
import { MINUTE } from './units';

/** Minutes after local midnight for `date`, honouring a fixed UTC offset. */
export function minuteOfDay(date: Millis, utcOffsetMinutes = 0): number {
  const local = date + utcOffsetMinutes * MINUTE;
  const m = Math.floor(local / MINUTE) % 1440;
  return m < 0 ? m + 1440 : m;
}

export function scheduleValueAt<T>(schedule: Schedule<T>, date: Millis, utcOffsetMinutes = 0): T {
  if (schedule.length === 0) throw new Error('Schedule is empty');
  const m = minuteOfDay(date, utcOffsetMinutes);
  let current = schedule[0]!.value;
  for (const entry of schedule) {
    if (entry.startMinute <= m) current = entry.value;
    else break;
  }
  return current;
}

/** Validates a schedule: non-empty, starts at 0, strictly ascending, within a day. */
export function validateSchedule<T>(schedule: Schedule<T>, isValid: (v: T) => boolean): string[] {
  const errors: string[] = [];
  if (schedule.length === 0) return ['Schedule must have at least one entry'];
  if (schedule[0]!.startMinute !== 0) errors.push('Schedule must start at 00:00');
  schedule.forEach((e, i) => {
    if (e.startMinute < 0 || e.startMinute >= 1440) errors.push(`Entry ${i}: start out of range`);
    if (i > 0 && e.startMinute <= schedule[i - 1]!.startMinute) errors.push(`Entry ${i}: not ascending`);
    if (!isValid(e.value)) errors.push(`Entry ${i}: invalid value`);
  });
  return errors;
}

export const constantSchedule = <T>(value: T): Schedule<T> => [{ startMinute: 0, value }];
