import { describe, expect, it } from 'vitest';
import type { GlucoseReading, LoopRun } from '@buddy/core';
import { averageOverDays, glucoseMetrics, gri, hourlyStats, intervalStart, loopStats, sectorStats, startOfDay, trioIntMedian, visibleDateRange } from '../calc';

const MIN = 60_000;
const reading = (date: number, value: number): GlucoseReading => ({ date, value, source: 'test' });
const run = (date: number, durationMs: number, error?: string): LoopRun =>
  ({ date, durationMs, error, mode: 'closed', algorithmId: 'x', glucose: 100, iob: 0, cob: 0, suggested: null, guarded: null, interventions: [], enacted: null }) as unknown as LoopRun;

describe('trioIntMedian', () => {
  it('uses integer division for even counts like Trio', () => {
    expect(trioIntMedian([100, 101])).toBe(100);
    expect(trioIntMedian([3, 1, 2])).toBe(2);
    expect(trioIntMedian([])).toBe(0);
  });
});

describe('hourlyStats', () => {
  it('returns 24 hours with index-based percentiles and zeros for empty hours', () => {
    const base = startOfDay(Date.UTC(2026, 10, 25, 12));
    const readings = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190].map((v, i) => reading(base + 8 * 60 * MIN + i * MIN, v));
    const stats = hourlyStats(readings);
    expect(stats).toHaveLength(24);
    const h8 = stats[8]!;
    expect(h8.median).toBe(145);
    expect(h8.p10).toBe(110);
    expect(h8.p25).toBe(120);
    expect(h8.p75).toBe(170);
    expect(h8.p90).toBe(190);
    expect(stats[9]!.median).toBe(0);
  });
});

describe('sectorStats', () => {
  it('counts readings in Trio ranges', () => {
    const t = Date.now();
    const s = sectorStats([reading(t, 60), reading(t + 1, 100), reading(t + 2, 150), reading(t + 3, 200)])!;
    expect(s.low).toBe(0.25);
    expect(s.inRange).toBe(0.5);
    expect(s.tight).toBe(0.25);
    expect(s.high).toBe(0.25);
    expect(s.counts).toEqual({ high: 1, inRange: 2, low: 1 });
    expect(sectorStats([])).toBeNull();
  });
});

describe('glucoseMetrics', () => {
  it('computes eA1c, GMI and days from the mean', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const m = glucoseMetrics([reading(t0, 100), reading(t0 + 12 * 60 * MIN, 140)]);
    expect(m.days).toBeCloseTo(0.5);
    expect(m.ngsp).toBeCloseTo((120 + 46.7) / 28.7);
    expect(m.gmi).toBeCloseTo(3.31 + 0.02392 * 120);
  });
});

describe('gri', () => {
  it('weights hypo and hyper components and assigns a zone', () => {
    const t = Date.now();
    const r = gri([reading(t, 50), reading(t, 100), reading(t, 100), reading(t, 300)])!;
    expect(r.veryLow).toBe(25);
    expect(r.veryHigh).toBe(25);
    expect(r.score).toBe(Math.min(100, 3 * 25 + 1.6 * 25));
    expect(r.zone).toBe('E');
    expect(gri([])).toBeNull();
  });
});

describe('loopStats', () => {
  it('reports successful loops per day, median duration and interval', () => {
    const now = Date.UTC(2026, 10, 25, 12);
    const runs = [run(now - 15 * MIN, 1000), run(now - 10 * MIN, 3000), run(now - 5 * MIN, 2000, 'failed')];
    const s = loopStats(runs, [reading(now - MIN, 100)], 'day', now)!;
    expect(s.loops).toBe(2);
    expect(s.totalDays).toBe(1);
    expect(s.medianDuration).toBe(2);
    expect(s.loopPercentage).toBeCloseTo((2 / 288) * 100);
    expect(s.medianInterval).toBeCloseTo(5 * 60 + 3);
    expect(loopStats([], [], 'day', now)).toBeNull();
  });
});

describe('ranges', () => {
  it('starts Today at local midnight and D 24 h back', () => {
    const now = Date.UTC(2026, 10, 25, 12);
    expect(intervalStart('today', now)).toBe(startOfDay(now));
    expect(intervalStart('day', now)).toBe(now - 24 * 60 * MIN);
  });

  it('averages per day over days with data', () => {
    const d0 = startOfDay(Date.UTC(2026, 10, 20, 12));
    const buckets = [0, 1, 2].map((i) => ({ date: d0 + i * 24 * 60 * MIN, values: [i === 1 ? 0 : 10 * (i + 1)] }));
    const range = visibleDateRange(d0 + 1000, 'week');
    expect(averageOverDays(buckets, 'week', range)).toBe(20);
  });
});
