import { describe, expect, it } from 'vitest';
import { glucoseStatus, scheduleValueAt, trendFromRate, validateSchedule, recommendBolus, HOUR } from '../src';
import { flatProfile, series, T0 } from './fixtures';

describe('glucoseStatus', () => {
  it('returns null without data', () => expect(glucoseStatus([])).toBeNull());

  it('computes deltas per 5 minutes like oref0', () => {
    const s = glucoseStatus(series(T0, 150, 5))!;
    expect(s.glucose).toBe(150);
    expect(s.delta).toBe(5);
    expect(s.shortAvgDelta).toBe(5);
    expect(s.longAvgDelta).toBe(5);
  });

  it('ignores readings from other sources', () => {
    const data = [...series(T0, 150, 5, 3, 'a'), { date: T0 - 5 * 60_000, value: 400, source: 'b' }];
    expect(glucoseStatus(data)!.delta).toBe(5);
  });
});

describe('schedules', () => {
  const s = [
    { startMinute: 0, value: 1 },
    { startMinute: 360, value: 2 },
  ];
  it('picks the active entry', () => {
    const midnight = Date.UTC(2026, 0, 1);
    expect(scheduleValueAt(s, midnight + 5 * HOUR)).toBe(1);
    expect(scheduleValueAt(s, midnight + 7 * HOUR)).toBe(2);
    expect(scheduleValueAt(s, midnight + 7 * HOUR, -120)).toBe(1);
  });
  it('validates ordering', () => {
    expect(validateSchedule(s, (v) => v > 0)).toEqual([]);
    expect(validateSchedule([{ startMinute: 30, value: 1 }], () => true)).toContain('Schedule must start at 00:00');
  });
});

describe('trend', () => {
  it('maps rates to arrows', () => {
    expect(trendFromRate(0)).toBe('flat');
    expect(trendFromRate(2.5)).toBe('singleUp');
    expect(trendFromRate(-3.5)).toBe('doubleDown');
  });
});

describe('bolus wizard', () => {
  it('combines carbs, correction and IOB and never goes negative', () => {
    const r = recommendBolus({ now: T0, profile: flatProfile, glucose: 150, delta: 0, carbs: 30, iob: 1, fraction: 1 });
    expect(r.carbUnits).toBe(3);
    expect(r.correctionUnits).toBe(1);
    expect(r.total).toBe(3);
    const low = recommendBolus({ now: T0, profile: flatProfile, glucose: 60, delta: -5, carbs: 0, iob: 2, fraction: 1 });
    expect(low.total).toBe(0);
  });
});
