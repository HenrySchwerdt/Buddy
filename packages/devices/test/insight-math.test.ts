import { describe, expect, it } from 'vitest';
import {
  bolusStepFor,
  bolusStepForAmount,
  DosingMathError,
  effectiveRate,
  normalizedBolus,
  normalizedDurationMinutes,
  parseBasalProfile,
  planTempBasal,
  profileKey,
  profileSegments,
  rateSegments,
  simplifyBasalSchedule,
  scheduledRateAt,
  tempSegments,
  validateBolus,
} from '../src/insight/dosing-math';

const flat = (r: number) => Array.from({ length: 24 }, () => r);
const OFFSET = 3600;
/** 10:00 local at UTC+1. */
const T10 = Date.UTC(2026, 10, 25, 9, 0, 0);
const MIN = 60_000;

describe('Insight pump grids', () => {
  it('uses the amount-dependent bolus step', () => {
    expect([0.5, 1.95, 2, 4.9, 5, 9.9, 10, 20].map(bolusStepForAmount)).toEqual([0.05, 0.05, 0.1, 0.1, 0.2, 0.2, 0.5, 0.5]);
    expect(bolusStepFor(1, 0.1)).toBe(0.1);
  });

  it('rounds boluses down to the grid and validates without clamping', () => {
    expect(normalizedBolus(0.57, 0.05)).toBe(0.55);
    expect(normalizedBolus(1.2000000000000002, 0.05)).toBe(1.2);
    expect(normalizedBolus(0.1 + 0.2, 0.05)).toBe(0.3);
    expect(() => validateBolus(0.5, 10, 0.05, 100)).not.toThrow();
    expect(() => validateBolus(0, 10, 0.05, null)).toThrowError(expect.objectContaining({ code: 'notPositive' }));
    expect(() => validateBolus(Number.NaN, 10, 0.05, null)).toThrow(DosingMathError);
    expect(() => validateBolus(11, 10, 0.05, null)).toThrowError(expect.objectContaining({ code: 'exceedsMaximum' }));
    expect(() => validateBolus(0.52, 10, 0.05, null)).toThrowError(expect.objectContaining({ code: 'notMultipleOfStep' }));
    expect(() => validateBolus(5, 10, 0.2, 4)).toThrowError(expect.objectContaining({ code: 'exceedsReservoir' }));
  });
});

describe('Insight basal profile', () => {
  it('parses 24 hourly rates or one flat rate and rejects off-grid or out-of-range rates', () => {
    expect(parseBasalProfile('0.8')).toEqual(flat(0.8));
    expect(parseBasalProfile(Array.from({ length: 24 }, (_, i) => 0.5 + i / 100).join(', '))[23]).toBeCloseTo(0.73, 6);
    expect(() => parseBasalProfile('')).toThrow(DosingMathError);
    expect(() => parseBasalProfile('1,2,3')).toThrow(/24/);
    expect(() => parseBasalProfile('0.025')).toThrow(/step/);
    expect(() => parseBasalProfile('0.01')).toThrow(/range/);
    expect(() => parseBasalProfile('26')).toThrow(/range/);
    expect(() => parseBasalProfile('abc')).toThrow(DosingMathError);
    expect(() => parseBasalProfile('5.05')).toThrow(/step/);
    expect(parseBasalProfile('5.1')[0]).toBe(5.1);
  });

  it('merges hours into segments summing to 1440 minutes', () => {
    const hourly = [...flat(1).slice(0, 6), ...flat(1.5).slice(0, 12), ...flat(1).slice(0, 6)];
    expect(profileSegments(hourly)).toEqual([
      { duration: 360, rate: 1 },
      { duration: 720, rate: 1.5 },
      { duration: 360, rate: 1 },
    ]);
    expect(profileSegments(flat(1)).reduce((n, s) => n + s.duration, 0)).toBe(1440);
    expect(profileKey(flat(1))).not.toBe(profileKey(flat(1.01)));
  });

  it('finds the scheduled rate and splits windows at the pump hour boundaries', () => {
    const hourly = Array.from({ length: 24 }, (_, h) => h / 10 + 0.1);
    expect(scheduledRateAt(hourly, T10, OFFSET)).toBeCloseTo(1.1, 6); // 10:00 local
    expect(scheduledRateAt(hourly, T10 - MIN, OFFSET)).toBeCloseTo(1.0, 6);
    const segs = rateSegments(hourly, T10 + 50 * MIN, T10 + 80 * MIN, OFFSET);
    expect(segs.map((s) => (s.end - s.start) / MIN)).toEqual([10, 20]);
    expect(segs.map((s) => s.rate)[0]).toBeCloseTo(1.1, 9);
    expect(segs.map((s) => s.rate)[1]).toBeCloseTo(1.2, 9);
    expect(rateSegments(hourly, T10, T10, OFFSET)).toEqual([]);
    // negative offsets and midnight wrap
    const midnight = Date.UTC(2026, 10, 25, 0, 30, 0);
    expect(scheduledRateAt(hourly, midnight, -3600)).toBeCloseTo(2.4, 6); // 23:30 local the day before
  });
});

describe('Insight temp basal planning', () => {
  it('rounds the percentage down so the pump never delivers more than requested', () => {
    const plan = planTempBasal(1.19, flat(1), T10, OFFSET, 30);
    expect(plan).toEqual({ kind: 'set', percent: 110, durationMinutes: 30, effectiveRate: 1.1 });
    expect(planTempBasal(0, flat(1), T10, OFFSET, 30)).toMatchObject({ kind: 'set', percent: 0, effectiveRate: 0 });
    expect(planTempBasal(0.99, flat(1), T10, OFFSET, 30)).toMatchObject({ percent: 90 });
    expect(planTempBasal(100, flat(1), T10, OFFSET, 30)).toMatchObject({ percent: 250 });
  });

  it('is a cancel when the request rounds to the scheduled rate', () => {
    expect(planTempBasal(1.0, flat(1), T10, OFFSET, 30)).toEqual({ kind: 'cancel' });
    expect(planTempBasal(1.09, flat(1), T10, OFFSET, 30)).toEqual({ kind: 'cancel' });
  });

  it('cannot express a temp basal on a scheduled rate of zero', () => {
    expect(() => planTempBasal(0.5, flat(0), T10, OFFSET, 30)).toThrowError(expect.objectContaining({ code: 'noScheduledBasal' }));
    expect(planTempBasal(0, flat(0), T10, OFFSET, 30)).toEqual({ kind: 'cancel' });
  });

  it('validates the request', () => {
    expect(() => planTempBasal(-1, flat(1), T10, OFFSET, 30)).toThrowError(expect.objectContaining({ code: 'invalidRate' }));
    expect(() => planTempBasal(Number.NaN, flat(1), T10, OFFSET, 30)).toThrow(DosingMathError);
    expect(() => planTempBasal(1, flat(1), T10, OFFSET, 0)).toThrowError(expect.objectContaining({ code: 'invalidDuration' }));
    expect(() => planTempBasal(1, flat(1), T10, OFFSET, Number.POSITIVE_INFINITY)).toThrow(DosingMathError);
    expect(normalizedDurationMinutes(44)).toBe(30);
    expect(normalizedDurationMinutes(1)).toBe(15);
    expect(normalizedDurationMinutes(100_000)).toBe(1440);
  });

  it('shortens a window that crosses a rate change by at least 15 minutes, otherwise bases it on the highest rate', () => {
    const hourly = Array.from({ length: 24 }, (_, h) => (h === 11 ? 2 : 1));
    // 10:30: the change is 30 minutes away
    expect(planTempBasal(0.5, hourly, T10 + 30 * MIN, OFFSET, 120)).toMatchObject({ percent: 50, durationMinutes: 30 });
    // 10:50: the change is 10 minutes away -> 15 minutes, percentage of the highest rate (2 U/h)
    const near = planTempBasal(1.0, hourly, T10 + 50 * MIN, OFFSET, 120);
    expect(near).toMatchObject({ kind: 'set', percent: 50, durationMinutes: 15 });
    // 10:44: 16 minutes -> 15 minutes, still against the current rate
    expect(planTempBasal(0.5, hourly, T10 + 44 * MIN, OFFSET, 120)).toMatchObject({ percent: 50, durationMinutes: 15 });
  });

  it('splits a percent temp basal into constant-rate segments that follow the schedule', () => {
    const hourly = Array.from({ length: 24 }, (_, h) => (h === 11 ? 2 : 1));
    const segs = tempSegments(50, T10 + 50 * MIN, 15, hourly, OFFSET, 1);
    expect(segs.map((s) => [s.rate, s.durationMin])).toEqual([
      [0.5, 10],
      [1, 5],
    ]);
    expect(tempSegments(50, T10, 30, flat(1), OFFSET, 1)).toEqual([{ date: T10, rate: 0.5, durationMin: 30 }]);
    expect(tempSegments(50, T10, 30, null, OFFSET, 2)).toEqual([{ date: T10, rate: 1, durationMin: 30 }]);
    expect(effectiveRate(120, 0.83)).toBe(0.996);
  });
});

describe('Insight profile conversion', () => {
  it('takes the minimum of everything inside each hour, rounded down to the pump grid', () => {
    const r = simplifyBasalSchedule([
      { startMinute: 0, value: 0.8 },
      { startMinute: 330, value: 1.234 },
      { startMinute: 600, value: 0.9 },
    ]);
    expect(r.wasSimplified).toBe(true);
    expect(r.rates).toHaveLength(24);
    expect(r.rates[5]).toBe(0.8); // 05:00-06:00 contains both 0.8 and 1.234
    expect(r.rates[6]).toBe(1.23); // floored to 0.01
    expect(r.rates[9]).toBe(1.23);
    expect(r.rates[10]).toBe(0.9);
    expect(Math.max(...r.rates)).toBeLessThanOrEqual(1.234);
  });

  it('leaves an hourly profile on the grid untouched and flags nothing', () => {
    const r = simplifyBasalSchedule([{ startMinute: 0, value: 1 }, { startMinute: 720, value: 1.5 }]);
    expect(r.wasSimplified).toBe(false);
    expect(r.rates.slice(0, 12).every((x) => x === 1)).toBe(true);
    expect(r.rates.slice(12).every((x) => x === 1.5)).toBe(true);
  });

  it('floors above 5 U/h to 0.1 and rejects invalid schedules', () => {
    expect(simplifyBasalSchedule([{ startMinute: 0, value: 5.57 }]).rates[0]).toBe(5.5);
    expect(() => simplifyBasalSchedule([])).toThrow(DosingMathError);
    expect(() => simplifyBasalSchedule([{ startMinute: 60, value: 1 }])).toThrow(/midnight/);
    expect(() => simplifyBasalSchedule([{ startMinute: 0, value: 1 }, { startMinute: 0, value: 2 }])).toThrow(/ascending/);
    expect(() => simplifyBasalSchedule([{ startMinute: 0, value: 30 }])).toThrow(/range/);
    expect(() => simplifyBasalSchedule([{ startMinute: 0, value: 0.01 }])).toThrow(/range/);
  });
});
