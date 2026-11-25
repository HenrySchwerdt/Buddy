/**
 * TypeScript port of the temp-basal and bolus-volume arithmetic in
 * DanaKit/PumpManager/DanaKitPumpManager.swift (`absoluteBasalRateToPercentage`,
 * `_enactTempBasal`, `isSupportedDuration`, `roundToSupportedBolusVolume`) and
 * `getScheduledBasalRate` in DanaKitPumpManagerState.swift, from loopandlearn/DanaKit
 * (MIT, © 2021 Randall Knutson and the DanaKit authors).
 *
 * Rounding (insulin is never rounded up):
 * - U/h → percent: DanaKit uses `round()`; Buddy uses floor (with a 1e-9 float tolerance), so a
 *   requested 1.5 U/h on a 0.8 U/h basal becomes 187 % (1.496 U/h), never 188 % (1.504 U/h).
 *   The divisor is the highest scheduled rate in the temp's window (DanaKit: the current hour), so
 *   a temp running into a higher-basal hour never exceeds the request; the reported rate is the
 *   rate in that highest hour (≤ request; lower hours deliver less than reported — conservative).
 * - Durations are rounded *down* exactly like DanaKit (>60 min → whole hours, >30 → 30, >15 → 15,
 *   below 15 min is rejected); a temp above 200 % is shortened to 15 min (pump limitation) and
 *   percentages above 500 % are capped at 500 %.
 * - The reported absolute rate is `percent / 100 × scheduled basal`, rounded to 0.01 U/h as in
 *   DanaKit (`rounded(toPlaces: 2)`) — it describes what the pump delivers, it is not a command.
 * - Bolus volumes are floored to the 0.05 U grid, max 30 U (`supportedBolusVolumes`).
 */
import type { Millis } from '@buddy/core';
import { LoopTempBasalDuration } from './packets/basal';

const FLOAT_TOLERANCE = 1e-9;
/** `onboardingSupportedBolusVolumes`: 0.05 U steps from 0.05 to 30 U. */
export const BOLUS_INCREMENT = 0.05;
export const MAX_SUPPORTED_BOLUS = 30;
/** `onboardingSupportedBasalRates`: 0.01 U/h steps. */
export const BASAL_INCREMENT = 0.01;
/** The pump does not support temp basals over 500% */
export const MAX_TEMP_PERCENT = 500;
/** Temp basal >15min && >200% is not supported */
export const MAX_LONG_TEMP_PERCENT = 200;
/** Dana temp basals run at most 24 h (the hour count is a single byte; DanaKit does not check). */
export const MAX_TEMP_DURATION_MIN = 24 * 60;

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** `roundToSupportedBolusVolume(units:)` — the largest supported volume ≤ units (0 if none). */
export function roundToSupportedBolusVolume(units: number): number {
  if (!Number.isFinite(units) || units < BOLUS_INCREMENT) return 0;
  const steps = Math.floor(Math.min(units, MAX_SUPPORTED_BOLUS) / BOLUS_INCREMENT + FLOAT_TOLERANCE);
  return round2(steps * BOLUS_INCREMENT);
}

/**
 * `getScheduledBasalRate`: the profile entry of the current local hour (DanaKit ignores the
 * `date` argument and always uses "now"; Buddy passes the time explicitly).
 */
export function scheduledBasalRate(basalSchedule: readonly number[], at: Millis): number {
  if (basalSchedule.length === 0) return 0; // Prevent crash if basalSchedule isnt set
  return basalSchedule[new Date(at).getHours()] ?? 0;
}

/** Highest scheduled rate in the profile hours touched by [at, at + durationMin). */
export function maxScheduledBasalRate(basalSchedule: readonly number[], at: Millis, durationMin: number): number {
  const startHour = new Date(at).getHours();
  const minutesIntoHour = new Date(at).getMinutes();
  const hours = Math.max(1, Math.ceil((minutesIntoHour + Math.max(0, durationMin)) / 60));
  let max = 0;
  for (let i = 0; i < Math.min(hours, 24); i++) max = Math.max(max, basalSchedule[(startHour + i) % 24] ?? 0);
  return max;
}

/**
 * `absoluteBasalRateToPercentage` with floor instead of round (see header). `null` = not possible.
 * The pump applies the percentage to every profile hour the temp runs through, while DanaKit
 * divides by the current hour only — a temp crossing into a higher-basal hour would then deliver
 * more than requested. Buddy divides by the highest scheduled rate in the window instead
 * (`durationMin` = 0 gives DanaKit's single-hour behaviour).
 */
export function absoluteBasalRateToPercentage(absoluteValue: number, basalSchedule: readonly number[], at: Millis, durationMin = 0): number | null {
  if (absoluteValue === 0) return 0;
  if (basalSchedule.length !== 24) return null;

  const basalRate = maxScheduledBasalRate(basalSchedule, at, durationMin);
  // Swift divides by zero here (∞ → trap in UInt16()); refuse instead
  if (!(basalRate > 0)) return null;

  return Math.floor((absoluteValue / basalRate) * 100 + FLOAT_TOLERANCE);
}

export type TempBasalCommand =
  | { readonly kind: 'short'; readonly code: LoopTempBasalDuration }
  | { readonly kind: 'hours'; readonly hours: number };

export type TempBasalPlan =
  | { readonly ok: true; readonly percent: number; readonly durationMin: number; readonly command: TempBasalCommand }
  | { readonly ok: false; readonly error: string };

/** `isSupportedDuration` (minutes instead of seconds). */
export const isSupportedDuration = (durationMin: number): boolean => durationMin === 0 || durationMin === 15 || durationMin === 30 || durationMin % 60 === 0;

/**
 * The duration/percentage part of `_enactTempBasal` for a non-zero duration:
 * "There are 2 ways to set a temp basal: the normal way (which only accepts full hours and
 * percentages) and a short APS-special temp basal command (which only accepts 15 min or 30 min).
 * A temp basal >200% for 30 min (or full hour) is rescheduled to 15min."
 */
export function planTempBasal(percentage: number, requestedDurationMin: number): TempBasalPlan {
  if (!Number.isFinite(requestedDurationMin) || requestedDurationMin <= 0) return { ok: false, error: 'Temp basal duration must be positive' };
  if (requestedDurationMin > MAX_TEMP_DURATION_MIN) return { ok: false, error: `Temp basal longer than ${MAX_TEMP_DURATION_MIN / 60} h is unsupported` };

  // Check if duration is supported
  // If not, round it down to nearest supported duration
  let duration = requestedDurationMin;
  if (!isSupportedDuration(duration)) {
    if (duration > 60) {
      // Round down to nearest full hour
      duration = 60 * Math.floor(duration / 60);
    } else if (duration > 30) {
      // Round down to 30 min
      duration = 30;
    } else if (duration > 15) {
      // Round down to 15 min
      duration = 15;
    } else {
      return { ok: false, error: 'Temp basal below 15 min is unsupported... (floor duration)' };
    }
  }

  // Temp basal >15min && >200% is not supported
  // Floor it down to 15min
  if (percentage > MAX_LONG_TEMP_PERCENT && duration !== 15) {
    duration = 15;
  }

  // The pump does not support temp basals over 500%
  const percent = Math.min(percentage, MAX_TEMP_PERCENT);

  if (duration === 15) return { ok: true, percent, durationMin: 15, command: { kind: 'short', code: LoopTempBasalDuration.min15 } };
  if (duration === 30) return { ok: true, percent, durationMin: 30, command: { kind: 'short', code: LoopTempBasalDuration.min30 } };
  return { ok: true, percent, durationMin: duration, command: { kind: 'hours', hours: Math.floor(duration / 60) } };
}

export interface TempSegment {
  readonly date: Millis;
  readonly durationMin: number;
  /** percent × the scheduled rate of this profile hour, U/h */
  readonly rate: number;
}

/**
 * What the pump actually runs: it applies the percentage to each profile hour's own scheduled rate,
 * so a temp is split at every local-hour boundary where that absolute rate changes (adjacent
 * hours with equal rates are merged).
 */
export function splitTempAtHours(percent: number, basalSchedule: readonly number[], at: Millis, durationMin: number): TempSegment[] {
  const end = at + durationMin * 60_000;
  const segments: TempSegment[] = [];
  let cursor = at;
  while (cursor < end) {
    const boundary = new Date(cursor);
    boundary.setHours(boundary.getHours() + 1, 0, 0, 0);
    const segEnd = Math.min(boundary.getTime(), end);
    const rate = percentToRate(percent, scheduledBasalRate(basalSchedule, cursor));
    const last = segments[segments.length - 1];
    if (last && last.rate === rate) segments[segments.length - 1] = { ...last, durationMin: (segEnd - last.date) / 60_000 };
    else segments.push({ date: cursor, durationMin: (segEnd - cursor) / 60_000, rate });
    cursor = segEnd;
  }
  return segments;
}

/** `((Double(percentage) / 100) * scheduledBasal).rounded(toPlaces: 2)` */
export const percentToRate = (percent: number, scheduledBasal: number): number => round2((percent / 100) * scheduledBasal);
