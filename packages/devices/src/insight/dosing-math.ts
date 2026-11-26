/**
 * Insight dosing math (port of InsightKit/PumpManager/DosingMath.swift): the pump's grids and
 * limits, absolute-rate to percent TBR conversion (conservative: the pump never delivers more
 * than requested), schedule-aware TBR planning across hour boundaries, hourly basal profiles and
 * bolus validation. Everything here is pure.
 *
 * Pump facts come from AndroidAPS `PumpType.ACCU_CHEK_INSIGHT` as documented in InsightKit.
 */
export const INSIGHT_SPEC = {
  minBasal: 0.02,
  maxBasalAbsolute: 25,
  /** bridge contract: min(pump maxBolus, 25) */
  maxBolusAbsolute: 25,
  defaultBolusStep: 0.05,
  reservoirCapacity: 200,
  tbrPercentStep: 10,
  tbrMaxPercent: 250,
  tbrMinMinutes: 15,
  tbrMaxMinutes: 1440,
  tbrDurationStep: 15,
} as const;

/** Bolus step by amount (U): 0.05 up to 2, 0.1 up to 5, 0.2 up to 10, 0.5 above. */
export function bolusStepForAmount(amount: number): number {
  if (amount < 2) return 0.05;
  if (amount < 5) return 0.1;
  if (amount < 10) return 0.2;
  return 0.5;
}

/** Basal step by rate (U/h): 0.01 below 5, 0.1 above. */
export const basalStepForRate = (rate: number): number => (rate < 5 ? 0.01 : 0.1);

/** True when `value` is a multiple of `step` (tolerates floating point noise). */
export function isMultiple(value: number, step: number, tolerance = 1e-6): boolean {
  if (!(step > 0) || !Number.isFinite(value)) return false;
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < tolerance;
}

export const roundToPlaces = (x: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

export type DosingMathErrorCode = 'invalidRate' | 'invalidDuration' | 'noScheduledBasal' | 'notPositive' | 'exceedsMaximum' | 'notMultipleOfStep' | 'exceedsReservoir' | 'invalidSchedule';

export class DosingMathError extends Error {
  constructor(
    readonly code: DosingMathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DosingMathError';
  }
}

// ── hourly basal profile ─────────────────────────────────────────────────────

/** 24 hourly rates (U/h), index = hour of the pump's local day. */
export type HourlyRates = readonly number[];

export interface RateSegment {
  readonly start: number;
  readonly end: number;
  readonly rate: number;
}

export interface BasalSegmentSpec {
  readonly duration: number;
  readonly rate: number;
}

/** The schedule split at hour boundaries of the pump's local clock (fixed UTC offset). */
export function rateSegments(hourly: HourlyRates, start: number, end: number, utcOffsetSeconds: number): RateSegment[] {
  if (!(end > start) || !Number.isFinite(start) || !Number.isFinite(end)) return [];
  const out: RateSegment[] = [];
  let cursor = start;
  while (cursor < end && out.length < 200) {
    const local = cursor / 1000 + utcOffsetSeconds;
    const hourIndex = Math.floor(local / 3600);
    const hourOfDay = (((hourIndex % 24) + 24) % 24) | 0;
    const boundary = ((hourIndex + 1) * 3600 - utcOffsetSeconds) * 1000;
    const segmentEnd = Math.min(boundary, end);
    out.push({ start: cursor, end: segmentEnd, rate: hourly[hourOfDay]! });
    cursor = segmentEnd;
  }
  return out;
}

/** Scheduled rate at `at` on the pump's local clock. */
export function scheduledRateAt(hourly: HourlyRates, at: number, utcOffsetSeconds: number): number {
  const hour = ((Math.floor((at / 1000 + utcOffsetSeconds) / 3600) % 24) + 24) % 24;
  return hourly[hour]!;
}

/** Hourly rates merged into contiguous segments (1...24, durations multiples of 60 min, sum 1440). */
export function profileSegments(hourly: HourlyRates): BasalSegmentSpec[] {
  const out: { duration: number; rate: number }[] = [];
  for (const rate of hourly) {
    const last = out[out.length - 1];
    if (last && last.rate === rate) last.duration += 60;
    else out.push({ duration: 60, rate });
  }
  return out;
}

/** Stable identity of a profile (to know whether the pump holds it). */
export const profileKey = (hourly: HourlyRates): string => hourly.map((r) => r.toFixed(3)).join(',');

/**
 * Parses the `basalProfile` setting: 24 comma / space separated hourly rates (U/h), or one value
 * for a flat profile. Rejects (never clamps) rates outside the pump's range or grid.
 */
export function parseBasalProfile(text: string, minRate: number = INSIGHT_SPEC.minBasal, maxRate: number = INSIGHT_SPEC.maxBasalAbsolute): HourlyRates {
  const parts = text
    .trim()
    .split(/[\s,;]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new DosingMathError('invalidSchedule', 'The basal profile is empty.');
  if (parts.length !== 1 && parts.length !== 24) throw new DosingMathError('invalidSchedule', `The basal profile needs 24 hourly rates (or one rate for a flat profile), got ${parts.length}.`);
  const rates = parts.map((p) => Number(p.replace(',', '.')));
  const hourly = parts.length === 1 ? Array.from({ length: 24 }, () => rates[0]!) : rates;
  for (const r of hourly) {
    if (!Number.isFinite(r) || r < minRate - 1e-9 || r > maxRate + 1e-9) throw new DosingMathError('invalidSchedule', `Basal rate ${r} U/h is outside the range of the pump.`);
    if (!isMultiple(r, basalStepForRate(r))) throw new DosingMathError('invalidSchedule', `Basal rate ${r} U/h is not a step the pump can deliver (0.01 U/h below 5 U/h, 0.1 U/h above).`);
  }
  return hourly;
}

/** Like `parseBasalProfile` but `null` instead of throwing (the setting may be empty). */
export function tryParseBasalProfile(text: string, minRate?: number, maxRate?: number): HourlyRates | null {
  try {
    return parseBasalProfile(text, minRate, maxRate);
  } catch {
    return null;
  }
}

export interface SimplifiedProfile {
  readonly rates: HourlyRates;
  /** The pump profile differs from what was asked for (not on full hours, or rates not on the pump's grid). */
  readonly wasSimplified: boolean;
}

/** Largest rate of the pump grid that is not above `rate` (0.01 U/h steps below 5 U/h, 0.1 above). */
function floorToPumpGrid(rate: number, minRate: number): number {
  const step = basalStepForRate(rate);
  return Math.max(roundToPlaces(Math.floor(rate / step + 1e-6) * step, 2), minRate);
}

/**
 * Conservative conversion of an arbitrary (e.g. 30-minute) profile to the hourly profile the Insight
 * can store (InsightKit `InsightBasalSchedule.simplified`): each hour gets the MINIMUM rate of
 * everything scheduled inside that hour, rounded DOWN to the pump's rate grid. The pump never
 * delivers more basal than the original profile asked for; temp basals compensate through the percentage.
 * `items` are `{ startMinute, value }` sorted by start, the first at 0.
 */
export function simplifyBasalSchedule(items: readonly { readonly startMinute: number; readonly value: number }[], minRate: number = INSIGHT_SPEC.minBasal, maxRate: number = INSIGHT_SPEC.maxBasalAbsolute): SimplifiedProfile {
  if (items.length === 0) throw new DosingMathError('invalidSchedule', 'The basal schedule is empty.');
  if (items[0]!.startMinute !== 0) throw new DosingMathError('invalidSchedule', 'The basal schedule must start at midnight.');
  let wasSimplified = false;
  items.forEach((item, i) => {
    if (!Number.isFinite(item.startMinute) || item.startMinute < 0 || item.startMinute >= 1440 || (i > 0 && item.startMinute <= items[i - 1]!.startMinute)) {
      throw new DosingMathError('invalidSchedule', 'The basal schedule entries must be in ascending order within one day.');
    }
    if (!Number.isFinite(item.value) || item.value < minRate - 1e-9 || item.value > maxRate + 1e-9) throw new DosingMathError('invalidSchedule', `Basal rate ${item.value} U/h is outside the range of the pump.`);
    if (item.startMinute % 60 !== 0) wasSimplified = true;
    if (!isMultiple(item.value, basalStepForRate(item.value))) wasSimplified = true;
  });
  const hourly = Array.from({ length: 24 }, () => Number.POSITIVE_INFINITY);
  items.forEach((item, i) => {
    const end = i + 1 < items.length ? items[i + 1]!.startMinute : 1440;
    for (let hour = 0; hour < 24; hour++) {
      if (item.startMinute < hour * 60 + 60 && end > hour * 60) hourly[hour] = Math.min(hourly[hour]!, item.value);
    }
  });
  return { rates: hourly.map((r) => floorToPumpGrid(r, minRate)), wasSimplified };
}

// ── temp basal ───────────────────────────────────────────────────────────────

export type TempBasalPlan = { readonly kind: 'cancel' } | { readonly kind: 'set'; readonly percent: number; readonly durationMinutes: number; readonly effectiveRate: number };

/** percent of scheduled, floored to 0.0001 U/h so it can never exceed the request through rounding. */
export function effectiveRate(percent: number, scheduledRate: number): number {
  const raw = (percent / 100) * scheduledRate;
  return Math.floor(raw * 10000 + 1e-6) / 10000;
}

/** Duration rounded **down** to 15 minute steps; at least 15, at most 1440. `null` if not positive/finite. */
export function normalizedDurationMinutes(durationMin: number): number | null {
  if (!Number.isFinite(durationMin) || durationMin <= 0) return null;
  const minutes = Math.floor(Math.min(durationMin, 2 * INSIGHT_SPEC.tbrMaxMinutes) + 1e-6);
  const stepped = Math.floor(minutes / INSIGHT_SPEC.tbrDurationStep) * INSIGHT_SPEC.tbrDurationStep;
  return Math.min(Math.max(stepped, INSIGHT_SPEC.tbrMinMinutes), INSIGHT_SPEC.tbrMaxMinutes);
}

function percentPlan(requested: number, base: number, current: number, minutes: number): TempBasalPlan {
  if (!Number.isFinite(requested) || requested < 0 || !Number.isFinite(base) || base < 0 || !Number.isFinite(current) || current < 0) {
    throw new DosingMathError('invalidRate', 'Invalid temporary basal rate.');
  }
  if (base < 0.0005) {
    if (requested < 0.0005) return { kind: 'cancel' }; // 0 of 0 is the scheduled delivery already
    throw new DosingMathError('noScheduledBasal', 'The scheduled basal rate is 0 U/h, a temporary basal cannot be expressed as a percentage.');
  }
  const percent = (requested / base) * 100;
  // clamp before converting: a huge request must not overflow
  const steps = Math.floor(Math.min(percent, 1000) / INSIGHT_SPEC.tbrPercentStep + 1e-6);
  const rounded = Math.min(steps * INSIGHT_SPEC.tbrPercentStep, INSIGHT_SPEC.tbrMaxPercent);
  if (rounded === 100) return { kind: 'cancel' };
  return { kind: 'set', percent: rounded, durationMinutes: minutes, effectiveRate: effectiveRate(rounded, current) };
}

/**
 * Schedule-aware conversion. The pump keeps the *percentage* across hourly basal changes, so a TBR
 * that runs over a boundary where the scheduled rate changes would deliver a different absolute
 * rate afterwards.
 * - If the first such boundary is at least 15 minutes away, the duration is shortened (15-minute
 *   steps, rounded down) so that the TBR ends at or before it; the next loop cycle sets a new one.
 * - If it is closer than 15 minutes the minimum duration of 15 minutes is used and the percentage is
 *   computed against the *highest* scheduled rate of that window, so the request is never exceeded.
 */
export function planTempBasal(requestedRate: number, hourly: HourlyRates, at: number, utcOffsetSeconds: number, durationMin: number): TempBasalPlan {
  if (!Number.isFinite(requestedRate) || requestedRate < 0) throw new DosingMathError('invalidRate', 'Invalid temporary basal rate.');
  const minutes = normalizedDurationMinutes(durationMin);
  if (minutes === null) throw new DosingMathError('invalidDuration', 'Invalid temporary basal duration.');

  const segments = rateSegments(hourly, at, at + minutes * 60_000, utcOffsetSeconds);
  const first = segments[0];
  if (!first) throw new DosingMathError('invalidDuration', 'Invalid temporary basal duration.');
  const current = first.rate;

  let boundary: number | null = null;
  for (let i = 1; i < segments.length; i++) {
    if (Math.abs(segments[i]!.rate - segments[i - 1]!.rate) > 1e-9) {
      boundary = segments[i]!.start;
      break;
    }
  }
  if (boundary === null) return percentPlan(requestedRate, current, current, minutes);

  const shortMinutes = Math.floor(Math.floor((boundary - at) / 60_000 + 1e-6) / INSIGHT_SPEC.tbrDurationStep) * INSIGHT_SPEC.tbrDurationStep;
  if (shortMinutes >= INSIGHT_SPEC.tbrMinMinutes) return percentPlan(requestedRate, current, current, Math.min(shortMinutes, minutes));
  const minimumWindow = at + INSIGHT_SPEC.tbrMinMinutes * 60_000;
  const highest = Math.max(...rateSegments(hourly, at, minimumWindow, utcOffsetSeconds).map((s) => s.rate), current);
  return percentPlan(requestedRate, highest, current, INSIGHT_SPEC.tbrMinMinutes);
}

export interface TempSegment {
  readonly date: number;
  readonly rate: number;
  readonly durationMin: number;
}

/**
 * A percent TBR as consecutive constant-rate segments (one per run of equal scheduled rate): the
 * pump keeps the percentage, so the absolute rate follows the schedule hour by hour.
 */
export function tempSegments(percent: number, start: number, minutes: number, hourly: HourlyRates | null, utcOffsetSeconds: number, fallbackScheduledRate: number): TempSegment[] {
  const end = start + minutes * 60_000;
  const raw = hourly ? rateSegments(hourly, start, end, utcOffsetSeconds) : [{ start, end, rate: fallbackScheduledRate }];
  const out: { date: number; end: number; rate: number }[] = [];
  for (const s of raw) {
    const rate = effectiveRate(percent, s.rate);
    const last = out[out.length - 1];
    if (last && last.rate === rate) last.end = s.end;
    else out.push({ date: s.start, end: s.end, rate });
  }
  return out.map((s) => ({ date: s.date, rate: s.rate, durationMin: roundToPlaces((s.end - s.date) / 60_000, 3) }));
}

// ── bolus ────────────────────────────────────────────────────────────────────

/** The step that applies to `units`: the pump's amount-dependent grid, never finer than the bridge's step. */
export const bolusStepFor = (units: number, bridgeStep: number): number => Math.max(bridgeStep, bolusStepForAmount(Number.isFinite(units) ? units : 0));

/** Rejects (never clamps) invalid amounts. `maxBolus` is the minimum of all known limits. */
export function validateBolus(units: number, maxBolus: number, step: number, reservoir: number | null): void {
  if (!Number.isFinite(units) || units <= 0) throw new DosingMathError('notPositive', 'The bolus amount must be greater than 0.');
  if (units > maxBolus + 1e-9) throw new DosingMathError('exceedsMaximum', `The bolus exceeds the maximum of ${maxBolus.toFixed(2)} U.`);
  if (!isMultiple(units, step)) throw new DosingMathError('notMultipleOfStep', `The bolus is not a multiple of ${step.toFixed(2)} U.`);
  if (reservoir !== null && units > reservoir + 1e-9) throw new DosingMathError('exceedsReservoir', `The reservoir only holds ${reservoir.toFixed(1)} U.`);
}

/** Rounds *down* to the bolus step grid and removes floating point noise (1.2, not 1.2000000000000002). */
export function normalizedBolus(units: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(units)) return units;
  return roundToPlaces(Math.floor(units / step + 1e-6) * step, 4);
}

/** Time the pump needs to deliver `units` (InsightKit `deliveryDuration`: 40 s per U, at least 5 s). */
export const deliveryDurationMs = (units: number): number => Math.max(units * 40, 5) * 1000;
