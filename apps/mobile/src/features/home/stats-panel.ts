import type { GlucoseReading } from '@buddy/core';

export type StatsFace = 'timeInRange' | 'distributionBar' | 'averages' | 'hidden';
export type StatsRange = 'today' | 'day' | 'week' | 'month' | 'threeMonths';
export type TimeInRangeType = 'timeInTightRange' | 'timeInNormoglycemia';

/** TimeInRangeType.bottomThreshold. */
export const TIR_BOTTOM: Record<TimeInRangeType, number> = { timeInTightRange: 70, timeInNormoglycemia: 63 };
/** Fixed consensus TIR upper bound (StatStateModel.highLimit), independent of the chart thresholds. */
export const TIR_HIGH_LIMIT = 180;

const SCOPE: Record<StatsRange, { scope: string; average: string }> = {
  today: { scope: 'today', average: "Today's Average" },
  day: { scope: 'last 24 hours', average: 'Average of the Last 24 Hours' },
  week: { scope: 'last 7 days', average: 'Average of the Last 7 Days' },
  month: { scope: 'last month', average: 'Average of the Last Month' },
  threeMonths: { scope: 'last 3 months', average: 'Average of the Last 3 Months' },
};
export const scopeName = (r: StatsRange) => SCOPE[r].scope;
export const averageSubtitle = (r: StatsRange) => SCOPE[r].average;

/** HomeStatsPanelRange.startDate (calendar arithmetic, local time). */
export function statsRangeStart(range: StatsRange, now: number): number {
  const d = new Date(now);
  switch (range) {
    case 'today':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
    case 'week':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
    case 'month':
      return new Date(d.getFullYear(), d.getMonth() - 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
    case 'threeMonths':
      return new Date(d.getFullYear(), d.getMonth() - 3, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
  }
}

export interface StatsPanelStats {
  readonly veryLowPct: number;
  readonly lowPct: number;
  readonly inRangePct: number;
  readonly highPct: number;
  readonly veryHighPct: number;
  /** mg/dL; null without readings. */
  readonly mean: number | null;
}

export const EMPTY_STATS: StatsPanelStats = { veryLowPct: 0, lowPct: 0, inRangePct: 0, highPct: 0, veryHighPct: 0, mean: null };

/** HomeStatsPanelStats.init + GlucoseDailyDistributionStats.compute. */
export function statsPanelStats(readings: readonly GlucoseReading[], range: StatsRange, now: number, tirType: TimeInRangeType): StatsPanelStats {
  const start = statsRangeStart(range, now);
  const v = readings.filter((r) => r.date >= start).map((r) => Math.round(r.value));
  if (v.length === 0) return EMPTY_STATS;
  const bottom = TIR_BOTTOM[tirType];
  const pct = (f: (x: number) => boolean) => (v.filter(f).length / v.length) * 100;
  return {
    veryLowPct: pct((x) => x < 54),
    lowPct: pct((x) => x < bottom && x >= 54),
    inRangePct: pct((x) => x >= bottom && x <= TIR_HIGH_LIMIT),
    highPct: pct((x) => x > TIR_HIGH_LIMIT && x <= 250),
    veryHighPct: pct((x) => x > 250),
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

/** gmiString: percent or mmol/mol. */
export function gmiString(mean: number | null, unit: 'percent' | 'mmolMol'): string {
  if (mean === null) return '--';
  const gmi = 3.31 + 0.02392 * mean;
  if (unit === 'mmolMol') return `${Math.round((gmi - 2.152) * 10.929)} mmol/mol`;
  return `${gmi.toFixed(1)} %`;
}

/** `.upToOneDecimalPercent`: 62 % or 62.5 %. */
export function upToOneDecimalPercent(pct: number): string {
  return `${Number(pct.toFixed(1))} %`;
}

export interface DistributionSegment {
  readonly key: 'veryLow' | 'low' | 'inRange' | 'high';
  readonly fraction: number;
}

export function distributionSegments(s: StatsPanelStats): readonly DistributionSegment[] {
  return [
    { key: 'veryLow', fraction: s.veryLowPct / 100 },
    { key: 'low', fraction: s.lowPct / 100 },
    { key: 'inRange', fraction: s.inRangePct / 100 },
    { key: 'high', fraction: (s.highPct + s.veryHighPct) / 100 },
  ];
}
