/**
 * TypeScript port of `LibreTransmitter/LibreGlucose.swift` and
 * `LibreSensor/GlucoseAlgorithm/GlucoseSmoothing.swift` from loopandlearn/LibreTransmitter
 * (MIT, (c) the LibreTransmitter authors; smoothing after xDrip PR #828).
 */
import type { Trend } from '@buddy/core';
import type { CalibrationInfo } from './calibration';
import { calibratedGlucose, hasMeasurementError, type Measurement } from './measurement';

export interface LibreGlucose {
  readonly unsmoothedGlucose: number;
  /** Smoothed value in mg/dL (equals `unsmoothedGlucose` when not smoothed). */
  readonly glucoseDouble: number;
  /** Epoch ms. */
  readonly timestamp: number;
  /**
   * Not in the Swift struct's effective state (its init drops the `error` argument); carried
   * here so the plugin can drop error-flagged readings.
   */
  readonly hasError: boolean;
}

/** `LibreGlucose.glucose`: `UInt16(glucoseDouble.rounded())`. */
export const roundedGlucose = (g: LibreGlucose): number => Math.round(g.glucoseDouble);

/** `isStateValid`: glucose >= 1. */
export const isStateValid = (g: LibreGlucose): boolean => roundedGlucose(g) >= 1;

/** Swift `GlucoseTrend` cases. */
export type LibreGlucoseTrend = 'upUpUp' | 'upUp' | 'up' | 'flat' | 'down' | 'downDown' | 'downDownDown';

export function toBuddyTrend(t: LibreGlucoseTrend | null): Trend | undefined {
  switch (t) {
    case 'upUpUp': return 'doubleUp';
    case 'upUp': return 'singleUp';
    case 'up': return 'fortyFiveUp';
    case 'flat': return 'flat';
    case 'down': return 'fortyFiveDown';
    case 'downDown': return 'singleDown';
    case 'downDownDown': return 'doubleDown';
    default: return undefined;
  }
}

/** `calculateSlope(current:last:)` in mg/dL per ms. */
export function calculateSlope(current: LibreGlucose, last: LibreGlucose): number {
  if (current.timestamp === last.timestamp) return 0;
  return (last.unsmoothedGlucose - current.unsmoothedGlucose) / (last.timestamp - current.timestamp);
}

/** `GetGlucoseTrend(current:last:)`; thresholds in mg/dL per minute, exactly as in Swift. */
export function getGlucoseTrend(current: LibreGlucose | undefined, last: LibreGlucose | undefined): LibreGlucoseTrend {
  if (!current || !last) return 'flat';
  const s = calculateSlope(current, last) * 60_000;
  if (s <= -3.5) return 'downDownDown';
  if (s <= -2) return 'downDown';
  if (s <= -1) return 'down';
  if (s <= 1) return 'flat';
  if (s <= 2) return 'up';
  if (s <= 3.5) return 'upUp';
  return 'flat'; // "flat is the new (tm) unknown" (Swift never reports upUpUp)
}

/** `CalculateSmothedData5Points(origtrends:)`. */
export function calculateSmoothedData5Points(orig: readonly LibreGlucose[]): LibreGlucose[] {
  const u = orig.map((g) => g.unsmoothedGlucose);
  const n = u.length;
  if (n < 5) return orig.map((g) => ({ ...g, glucoseDouble: g.unsmoothedGlucose }));
  const smoothed = new Array<number>(n);
  for (let i = 0; i < n - 4; i++) smoothed[i] = (u[i]! + u[i + 1]! + u[i + 2]! + u[i + 3]! + u[i + 4]!) / 5;
  smoothed[n - 4] = (u[n - 4]! + u[n - 3]! + u[n - 2]! + u[n - 1]!) / 4;
  smoothed[n - 3] = (u[n - 3]! + u[n - 2]! + u[n - 1]!) / 3;
  smoothed[n - 2] = (u[n - 2]! + u[n - 1]!) / 2;
  smoothed[n - 1] = smoothed[n - 2]!;
  return orig.map((g, i) => ({ ...g, glucoseDouble: smoothed[i]! }));
}

/** `LibreGlucose.fromHistoryMeasurements`. */
export function fromHistoryMeasurements(measurements: readonly Measurement[], calibration: CalibrationInfo): LibreGlucose[] {
  return measurements.flatMap((m) => {
    const calibrated = calibratedGlucose(m, calibration);
    const g: LibreGlucose = { unsmoothedGlucose: calibrated, glucoseDouble: calibrated, timestamp: m.date, hasError: hasMeasurementError(m) };
    return g.glucoseDouble > 0 ? [g] : [];
  });
}

/** `LibreGlucose.fromTrendMeasurements`: keeps values in (0, 500] and smooths unless any value was <= 0. */
export function fromTrendMeasurements(measurements: readonly Measurement[], calibration: CalibrationInfo): LibreGlucose[] {
  const arr: LibreGlucose[] = [];
  let shouldSmooth = true;
  for (const m of measurements) {
    const g: LibreGlucose = { unsmoothedGlucose: calibratedGlucose(m, calibration), glucoseDouble: 0, timestamp: m.date, hasError: hasMeasurementError(m) };
    if (g.unsmoothedGlucose > 0 && g.unsmoothedGlucose <= 500) arr.push(g);
    if (g.unsmoothedGlucose <= 0) shouldSmooth = false;
  }
  return shouldSmooth ? calculateSmoothedData5Points(arr) : arr.map((g) => ({ ...g, glucoseDouble: g.unsmoothedGlucose }));
}
