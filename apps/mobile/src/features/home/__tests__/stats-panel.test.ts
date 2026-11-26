import { describe, expect, it } from 'vitest';
import type { GlucoseReading } from '@buddy/core';
import { distributionSegments, gmiString, statsPanelStats, statsRangeStart, upToOneDecimalPercent } from '../stats-panel';

const r = (date: number, value: number): GlucoseReading => ({ date, value, source: 't' });
const NOW = new Date(2026, 10, 26, 15, 30).getTime();
const HOUR = 3_600_000;

describe('statsRangeStart', () => {
  it('today starts at local midnight, day is 24 h back, week 7 days back', () => {
    expect(statsRangeStart('today', NOW)).toBe(new Date(2026, 10, 26).getTime());
    expect(statsRangeStart('day', NOW)).toBe(new Date(2026, 10, 25, 15, 30).getTime());
    expect(statsRangeStart('week', NOW)).toBe(new Date(2026, 10, 19, 15, 30).getTime());
    expect(statsRangeStart('threeMonths', NOW)).toBe(new Date(2026, 7, 26, 15, 30).getTime());
  });
});

describe('statsPanelStats', () => {
  const readings = [r(NOW - 30 * HOUR, 300), r(NOW - 3 * HOUR, 50), r(NOW - 2 * HOUR, 60), r(NOW - HOUR, 100), r(NOW - 1000, 200)];
  it('buckets like GlucoseDailyDistributionStats within the range only', () => {
    const s = statsPanelStats(readings, 'today', NOW, 'timeInTightRange');
    expect(s.veryLowPct).toBe(25);
    expect(s.lowPct).toBe(25);
    expect(s.inRangePct).toBe(25);
    expect(s.highPct).toBe(25);
    expect(s.mean).toBe(102.5);
  });
  it('the normoglycemia type lowers the bottom threshold to 63', () => {
    const s = statsPanelStats([r(NOW - 1000, 65)], 'today', NOW, 'timeInNormoglycemia');
    expect(s.inRangePct).toBe(100);
    expect(statsPanelStats([r(NOW - 1000, 65)], 'today', NOW, 'timeInTightRange').lowPct).toBe(100);
  });
  it('has no mean without readings in range', () => expect(statsPanelStats([r(NOW - 30 * HOUR, 100)], 'today', NOW, 'timeInTightRange').mean).toBeNull());
  it('merges high and very high in the bar', () => {
    const s = statsPanelStats([r(NOW - 1, 200), r(NOW - 2, 300)], 'today', NOW, 'timeInTightRange');
    expect(distributionSegments(s).find((x) => x.key === 'high')!.fraction).toBe(1);
  });
});

describe('formatting', () => {
  it('GMI in percent or mmol/mol', () => {
    expect(gmiString(null, 'percent')).toBe('--');
    expect(gmiString(150, 'percent')).toBe('6.9 %');
    expect(gmiString(150, 'mmolMol')).toBe('52 mmol/mol');
  });
  it('upToOneDecimalPercent drops a trailing .0', () => {
    expect(upToOneDecimalPercent(62)).toBe('62 %');
    expect(upToOneDecimalPercent(62.46)).toBe('62.5 %');
  });
});
