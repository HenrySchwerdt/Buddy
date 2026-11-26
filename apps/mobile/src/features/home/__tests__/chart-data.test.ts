import { describe, expect, it } from 'vitest';
import type { LoopRun } from '@buddy/core';
import { cobIobDomain, historyPoints, scaledIob } from '../cob-iob';
import { forecastCone, forecastLines } from '../forecast';
import { sensorLifecycle } from '../sensor-lifecycle';
import { remainingFraction } from '../adjustment-text';

const MIN = 60_000;
const run = (date: number, cob: number, iob: number, error?: string) => ({ date, cob, iob, error }) as unknown as LoopRun;

describe('cob/iob', () => {
  it('scales IOB 8x when positive and 9x when negative', () => {
    expect(scaledIob(2)).toBe(16);
    expect(scaledIob(-1)).toBe(-9);
  });
  it('drops failed runs and duplicate dates, keeping the first', () => {
    const pts = historyPoints([run(10, 5, 1), run(10, 6, 2), run(20, 0, 0, 'boom'), run(30, 7.6, 1)], 0, 100);
    expect(pts.map((p) => [p.t, p.cob])).toEqual([[10, 5], [30, 8]]);
  });
  it('uses the default domain without data and COB + 20 otherwise', () => {
    expect(cobIobDomain([])).toEqual({ min: 0, max: 40 });
    expect(cobIobDomain([{ t: 0, cob: 50, iob: 1 }])).toEqual({ min: 0, max: 70 });
    expect(cobIobDomain([{ t: 0, cob: 0, iob: 10 }])).toEqual({ min: 0, max: 80 });
    expect(cobIobDomain([{ t: 0, cob: 0, iob: -2 }]).min).toBe(-18);
  });
});

describe('forecast', () => {
  const p = { iob: [100, 110, 120], cob: [100, 130, 150], zt: [100, 100, 90] };
  it('cone is the min/max envelope per step, widened by 1 mg/dL when degenerate', () => {
    const cone = forecastCone(p, 0, 0);
    expect(cone).toEqual([{ t: 0, lo: 99, hi: 101 }, { t: 5 * MIN, lo: 100, hi: 130 }, { t: 10 * MIN, lo: 90, hi: 150 }]);
  });
  it('clips to 2.5 h ahead and ignores single-point curves', () => {
    const long = { iob: Array.from({ length: 60 }, () => 100), uam: [100] };
    expect(forecastLines(long, 0, 0)).toHaveLength(1);
    expect(forecastLines(long, 0, 0)[0]!.points.at(-1)!.t).toBe(150 * MIN);
  });
});

describe('sensorLifecycle', () => {
  const H = 3_600_000;
  it('counts down days and hours while healthy', () => {
    const s = sensorLifecycle({ startedAt: 0, expiresAt: 10 * 24 * H }, 4 * 24 * H + 10 * H);
    expect(s).toMatchObject({ text: '5d 14h', theme: 'green', arc: 'normal' });
    expect(s.progress).toBeCloseTo(0.4417, 3);
  });
  it('warns in the last day and flags expiry', () => {
    expect(sensorLifecycle({ startedAt: 0, expiresAt: 10 * 24 * H }, 10 * 24 * H - 22 * H - 1)).toMatchObject({ text: '22h left', theme: 'orange', arc: 'warning' });
    expect(sensorLifecycle({ startedAt: 0, expiresAt: 100 }, 200)).toMatchObject({ text: 'sensor expired', theme: 'red', arc: 'critical', progress: 1 });
  });
  it('shows warmup first', () => expect(sensorLifecycle({ startedAt: 0, expiresAt: 1e9, warmupEndsAt: 1000 }, 500)).toMatchObject({ text: 'warming up', theme: 'secondary', progress: 0.5 }));
});

describe('remainingFraction', () => {
  it('shrinks from 1 to 0 and is null when indefinite', () => {
    expect(remainingFraction(0, 60, 15 * MIN)).toBe(0.75);
    expect(remainingFraction(0, 60, 90 * MIN)).toBe(0);
    expect(remainingFraction(0, null, 5)).toBeNull();
  });
});

import { glucoseDomain, glucoseTicks, hourTicks, paneHeights, showBolusLabel, targetSegments } from '../chart-geometry';
import { DEFAULT_PROFILE } from '@buddy/core';

describe('chart geometry', () => {
  it('splits the stack 10 / 66 / 24 and gives the glucose pane the rest without COB/IOB', () => {
    expect(paneHeights(100, true)).toEqual({ basal: 10, main: 66, cobIob: 24 });
    expect(paneHeights(100, false).main).toBeCloseTo(90);
    expect(paneHeights(100, false).cobIob).toBe(0);
  });
  it('pads the glucose domain by 25 and steps the max in 50s up to 400', () => {
    expect(glucoseDomain([], [], 70)).toEqual({ min: 14, max: 225 });
    expect(glucoseDomain([100, 150], [], 70)).toEqual({ min: 25, max: 225 });
    expect(glucoseDomain([100, 240], [], 70).max).toBe(375);
    expect(glucoseDomain([100, 500], [], 70).max).toBe(425);
    expect(glucoseDomain([30, 100], [], 70).min).toBe(5);
  });
  it('limits forecast influence to 50 above the highest reading', () => {
    expect(glucoseDomain([100], [400], 70).max).toBe(225);
  });
  it('ticks every 50 mg/dL', () => expect(glucoseTicks({ min: 25, max: 225 }, 'mg/dL')).toEqual([50, 100, 150, 200]));
  it('keeps hour ticks on whole hours, every 2nd / 3rd hour when zoomed out', () => {
    const t0 = new Date(2026, 10, 26, 8, 20).getTime();
    const t1 = new Date(2026, 10, 26, 14, 0).getTime();
    expect(hourTicks(t0, t1, 6).map((t) => new Date(t).getHours())).toEqual([9, 10, 11, 12, 13, 14]);
    expect(hourTicks(t0, t1, 12).map((t) => new Date(t).getHours())).toEqual([10, 12, 14]);
  });
  it('merges equal consecutive profile targets into one segment', () => {
    const segs = targetSegments(DEFAULT_PROFILE, new Date(2026, 10, 26, 0).getTime(), new Date(2026, 10, 26, 6).getTime());
    expect(segs.length).toBeLessThan(12);
    expect(segs[0]!.from).toBeLessThanOrEqual(new Date(2026, 10, 26, 0).getTime());
  });
  it('shows the bolus label at or above the threshold', () => {
    expect(showBolusLabel(0.5, 0.5)).toBe(true);
    expect(showBolusLabel(0.3, 0.5)).toBe(false);
  });
});
