import { describe, expect, it } from 'vitest';
import {
  agpPercentiles,
  computeGlucoseStats,
  dailyBreakdown,
  DAY,
  insulinStats,
  localDayStart,
  percentile,
  readingWeights,
  scheduledBasal,
  HOUR,
  MINUTE,
  type GlucoseReading,
  type InsulinDose,
  type TherapyProfile,
} from '../src';
import { flatProfile, T0 } from './fixtures';

const reading = (date: number, value: number): GlucoseReading => ({ date, value, source: 'test' });
/** One reading every `stepMin` minutes starting at `start`. */
const evenly = (start: number, values: readonly number[], stepMin = 5): GlucoseReading[] =>
  values.map((v, i) => reading(start + i * stepMin * MINUTE, v));

describe('computeGlucoseStats', () => {
  it('computes consensus range percentages with inclusive 70–180 / 70–140 bounds', () => {
    const values = [50, 60, 70, 100, 140, 141, 180, 181, 250, 251, 120, 120];
    const s = computeGlucoseStats(evenly(T0, values), { from: T0, to: T0 + HOUR });
    expect(s.count).toBe(12);
    expect(s.coverage).toBeCloseTo(100);
    expect(s.tbr).toBeCloseTo((2 / 12) * 100);
    expect(s.tbrVeryLow).toBeCloseTo((1 / 12) * 100);
    expect(s.tir).toBeCloseTo((7 / 12) * 100);
    expect(s.titr).toBeCloseTo((5 / 12) * 100);
    expect(s.tar).toBeCloseTo((3 / 12) * 100);
    expect(s.tarVeryHigh).toBeCloseTo((1 / 12) * 100);
    expect(s.tbr! + s.tir! + s.tar!).toBeCloseTo(100);
    expect(s.min).toBe(50);
    expect(s.max).toBe(251);
    expect(s.mean).toBeCloseTo(1663 / 12);
  });

  it('computes mean, median, SD, CV, GMI and ADAG A1c', () => {
    const s = computeGlucoseStats(evenly(T0, [100, 200, 150]), { from: T0, to: T0 + 15 * MINUTE });
    expect(s.mean).toBe(150);
    expect(s.median).toBe(150);
    expect(s.sd).toBeCloseTo(50); // sample SD: sqrt((50² + 0 + 50²) / 2)
    expect(s.cv).toBeCloseTo(33.333, 3);
    expect(s.gmi).toBeCloseTo(3.31 + 0.02392 * 150); // 6.898
    expect(s.a1cEstimate).toBeCloseTo((150 + 46.7) / 28.7); // 6.854
  });

  it('honours custom thresholds', () => {
    const s = computeGlucoseStats(evenly(T0, [65, 75, 165, 175]), { from: T0, to: T0 + 20 * MINUTE, low: 80, high: 160, tightHigh: 170 });
    expect(s.tbr).toBe(50);
    expect(s.tar).toBe(50);
    expect(s.tir).toBe(0);
  });

  it('weights readings by the time until the next one', () => {
    // 10-min gap is counted: 60 mg/dL for 10 min, 200 for 5 min
    const s = computeGlucoseStats([reading(T0, 60), reading(T0 + 10 * MINUTE, 200)], { from: T0, to: T0 + 15 * MINUTE });
    expect(s.tbr).toBeCloseTo((10 / 15) * 100);
    expect(s.tar).toBeCloseTo((5 / 15) * 100);
  });

  it('does not count gaps longer than 15 minutes', () => {
    const data = [reading(T0, 60), reading(T0 + 5 * MINUTE, 60), reading(T0 + 65 * MINUTE, 200), reading(T0 + 70 * MINUTE, 200)];
    expect(readingWeights(data, T0 + 75 * MINUTE)).toEqual([5, 5, 5, 5]);
    const s = computeGlucoseStats(data, { from: T0, to: T0 + 75 * MINUTE });
    expect(s.tbr).toBe(50);
    expect(s.tar).toBe(50);
    expect(s.coverage).toBeCloseTo((4 / 15) * 100);
  });

  it('caps the last reading at 5 minutes and at the window end', () => {
    expect(readingWeights([reading(T0, 100)], T0 + 2 * MINUTE)).toEqual([2]);
    expect(readingWeights([reading(T0, 100)], T0 + HOUR)).toEqual([5]);
  });

  it('computes coverage from expected 5-min readings and caps it at 100 %', () => {
    expect(computeGlucoseStats(evenly(T0, Array(6).fill(100)), { from: T0, to: T0 + HOUR }).coverage).toBeCloseTo(50);
    expect(computeGlucoseStats(evenly(T0, Array(60).fill(100), 1), { from: T0, to: T0 + HOUR }).coverage).toBe(100);
  });

  it('filters by [from, to), ignores invalid values and accepts any order', () => {
    const data = [reading(T0 + HOUR, 300), reading(T0 + 5 * MINUTE, 38), reading(T0 + 10 * MINUTE, 120), reading(T0, 100), reading(T0 - 1, 40)];
    const s = computeGlucoseStats(data, { from: T0, to: T0 + HOUR });
    expect(s.count).toBe(2);
    expect(s.mean).toBe(110);
  });

  it('returns nulls without data', () => {
    const s = computeGlucoseStats([], { from: T0, to: T0 + HOUR });
    expect(s).toMatchObject({ count: 0, coverage: 0, mean: null, sd: null, tir: null, min: null });
  });

  it('reports SD 0 for a single reading and rejects an empty window', () => {
    expect(computeGlucoseStats([reading(T0, 100)], { from: T0, to: T0 + HOUR }).sd).toBe(0);
    expect(() => computeGlucoseStats([], { from: T0, to: T0 })).toThrow(RangeError);
  });
});

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('dailyBreakdown', () => {
  const jan1 = Date.UTC(2026, 0, 1);

  it('splits by local day using the UTC offset', () => {
    // UTC+1: 22:30Z is 23:30 on Jan 1, 23:30Z is 00:30 on Jan 2
    const data = [reading(jan1 + 22.5 * HOUR, 60), reading(jan1 + 23.5 * HOUR, 200)];
    const days = dailyBreakdown(data, 2, 60);
    expect(days.map((d) => d.day)).toEqual(['2026-01-01', '2026-01-02']);
    expect(days[0]!.from).toBe(jan1 - HOUR);
    expect(days[0]!.to).toBe(jan1 + 23 * HOUR);
    expect(days[0]!.stats).toMatchObject({ count: 1, tbr: 100 });
    expect(days[1]!.stats).toMatchObject({ count: 1, tar: 100 });
  });

  it('includes empty days and honours an explicit anchor', () => {
    const data = [reading(jan1 + 12 * HOUR, 120)];
    const days = dailyBreakdown(data, 3, 0, { now: jan1 + DAY + HOUR });
    expect(days.map((d) => d.day)).toEqual(['2025-12-31', '2026-01-01', '2026-01-02']);
    expect(days.map((d) => d.stats.count)).toEqual([0, 1, 0]);
  });

  it('passes custom thresholds through', () => {
    const days = dailyBreakdown([reading(jan1 + HOUR, 75)], 1, 0, { low: 80 });
    expect(days[0]!.stats.tbr).toBe(100);
  });

  it('returns [] without readings or anchor and rejects bad day counts', () => {
    expect(dailyBreakdown([], 7)).toEqual([]);
    expect(() => dailyBreakdown([], 0)).toThrow(RangeError);
  });

  it('localDayStart handles negative offsets', () => {
    // UTC-5: 03:00Z on Jan 1 is 22:00 on Dec 31, which started at 05:00Z Dec 31
    expect(localDayStart(jan1 + 3 * HOUR, -300)).toBe(jan1 - 19 * HOUR);
  });
});

describe('insulinStats', () => {
  const day = Date.UTC(2026, 0, 1);
  const twoRate: TherapyProfile = { ...flatProfile, basal: [{ startMinute: 0, value: 1 }, { startMinute: 720, value: 2 }] };

  it('integrates the scheduled basal exactly across schedule boundaries', () => {
    expect(scheduledBasal(twoRate, day, day + DAY)).toBeCloseTo(36);
    expect(scheduledBasal(twoRate, day + 6 * HOUR, day + 18 * HOUR)).toBeCloseTo(18);
    expect(scheduledBasal({ ...twoRate, utcOffsetMinutes: 60 }, day + 6 * HOUR, day + 18 * HOUR)).toBeCloseTo(19);
    expect(scheduledBasal(twoRate, day + 11.5 * HOUR, day + 12.25 * HOUR)).toBeCloseTo(0.5 + 0.5);
  });

  it('splits basal, bolus and SMB with temps absolute and scheduled basal elsewhere', () => {
    const doses: InsulinDose[] = [
      { kind: 'bolus', date: day + 12 * HOUR, units: 5, id: 'b' },
      { kind: 'smb', date: day + 13 * HOUR, units: 0.5, id: 's1' },
      { kind: 'smb', date: day + 14 * HOUR, units: 0.5, id: 's2' },
      { kind: 'tempBasal', date: day + 6 * HOUR, rate: 2, durationMin: 60, id: 't' },
      { kind: 'suspend', date: day + 8 * HOUR, durationMin: 30, id: 'x' },
    ];
    const s = insulinStats(doses, flatProfile, day, day + DAY);
    // basal: 24 scheduled − 1 (temp hour) + 2 (temp) − 0.5 (suspend)
    expect(s.basal).toBeCloseTo(24.5);
    expect(s.bolus).toBe(5);
    expect(s.smb).toBe(1);
    expect(s.totalDaily).toBeCloseTo(30.5);
    expect(s.basalPercent).toBeCloseTo((24.5 / 30.5) * 100);
    expect(s.days).toBe(1);
  });

  it('averages over multiple days', () => {
    const doses: InsulinDose[] = [{ kind: 'bolus', date: day + HOUR, units: 10, id: 'b' }];
    const s = insulinStats(doses, flatProfile, day, day + 2 * DAY);
    expect(s.basal).toBeCloseTo(24);
    expect(s.bolus).toBe(5);
    expect(s.totalDaily).toBeCloseTo(29);
  });

  it('truncates a temp at the next basal event', () => {
    const doses: InsulinDose[] = [
      { kind: 'tempBasal', date: day + 6 * HOUR, rate: 2, durationMin: 120, id: 't1' },
      { kind: 'tempBasal', date: day + 7 * HOUR, rate: 0, durationMin: 30, id: 't2' },
    ];
    // 06–07 at 2 U/h, 07–07:30 at 0, scheduled 1 U/h for the other 22.5 h
    expect(insulinStats(doses, flatProfile, day, day + DAY).basal).toBeCloseTo(24.5);
  });

  it('clips temps that start before the window and ignores doses outside it', () => {
    const doses: InsulinDose[] = [
      { kind: 'tempBasal', date: day - 30 * MINUTE, rate: 3, durationMin: 60, id: 't' },
      { kind: 'bolus', date: day - MINUTE, units: 4, id: 'before' },
      { kind: 'bolus', date: day + DAY, units: 4, id: 'after' },
    ];
    const s = insulinStats(doses, flatProfile, day, day + DAY);
    expect(s.basal).toBeCloseTo(23.5 + 1.5);
    expect(s.bolus).toBe(0);
  });

  it('handles an empty window of delivery and rejects a bad range', () => {
    const zero: TherapyProfile = { ...flatProfile, basal: [{ startMinute: 0, value: 0 }] };
    expect(insulinStats([], zero, day, day + DAY)).toMatchObject({ totalDaily: 0, basalPercent: null });
    expect(() => insulinStats([], flatProfile, day, day)).toThrow(RangeError);
  });
});

describe('agpPercentiles', () => {
  const day = Date.UTC(2026, 0, 1);

  it('computes percentiles per time-of-day bucket across days', () => {
    const data = [100, 110, 120, 130, 140].map((v, i) => reading(day + i * DAY + 10 * MINUTE, v));
    const buckets = agpPercentiles(data);
    expect(buckets).toHaveLength(48);
    expect(buckets[0]).toEqual({ startMinute: 0, count: 5, p5: 102, p25: 110, p50: 120, p75: 130, p95: 138 });
    expect(buckets[1]).toMatchObject({ startMinute: 30, count: 0, p50: null });
    expect(buckets[47]!.startMinute).toBe(1410);
  });

  it('uses local time of day and custom bucket sizes', () => {
    const data = [reading(day + 23 * HOUR + 40 * MINUTE, 100)]; // 00:40 at UTC+1
    expect(agpPercentiles(data, 30, 60)[1]!.count).toBe(1);
    const hourly = agpPercentiles([reading(day + 13 * HOUR + 59 * MINUTE, 100)], 60);
    expect(hourly).toHaveLength(24);
    expect(hourly[13]!.count).toBe(1);
  });

  it('ignores invalid readings and rejects buckets that do not divide a day', () => {
    expect(agpPercentiles([reading(day, 30)])[0]!.count).toBe(0);
    expect(() => agpPercentiles([], 7)).toThrow(RangeError);
    expect(() => agpPercentiles([], 0)).toThrow(RangeError);
  });
});
