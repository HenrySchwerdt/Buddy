import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, type DataSnapshot, type GlucoseReading } from '@buddy/core';
import { aggregateVisibleDays, dailyGlucose, startOfDay } from '../calc';
import { buildReportHtml, esc, isPerDayChart, orderCharts, type ReportChartType } from '../pdf-report';

const NOW = Date.UTC(2026, 10, 25, 12);
const reading = (date: number, value: number): GlucoseReading => ({ date, value, source: 't' });
const readings = Array.from({ length: 288 * 3 }, (_, i) => reading(NOW - i * 5 * 60_000, 90 + ((i * 7) % 120)));
const snap = { glucose: readings, doses: [], carbs: [], loopRuns: [] } as unknown as DataSnapshot;

describe('pdf report', () => {
  it('orders selected charts in menu order', () => {
    const sel = new Set<ReportChartType>(['mealsTotalMeals', 'glucosePercentileByTime', 'therapyBasalRates']);
    expect(orderCharts(sel)).toEqual(['glucosePercentileByTime', 'mealsTotalMeals', 'therapyBasalRates']);
  });

  it('marks per-day charts', () => {
    expect(isPerDayChart('glucosePercentileByDay')).toBe(true);
    expect(isPerDayChart('glucosePercentileByTime')).toBe(false);
  });

  it('renders one page per chart with svg, patient name and escapes it', () => {
    const html = buildReportHtml({ snap, profile: DEFAULT_PROFILE, units: 'mg/dL', now: NOW, range: 'week', charts: ['glucosePercentileByTime', 'glucoseDistributionByDay', 'therapyBasalRates', 'insulinTotalDailyDose'], patientName: '<b>Ann</b>' });
    expect(html.match(/<section class="page">/g)).toHaveLength(4);
    expect(html).toContain('<svg');
    expect(html).toContain('&lt;b&gt;Ann&lt;/b&gt;');
    expect(html).not.toContain('<b>Ann</b>');
    expect(html).not.toContain('NaN');
  });

  it('reports no data instead of failing on an empty snapshot', () => {
    const empty = { glucose: [], doses: [], carbs: [], loopRuns: [] } as unknown as DataSnapshot;
    const html = buildReportHtml({ snap: empty, profile: DEFAULT_PROFILE, units: 'mmol/L', now: NOW, range: 'day', charts: ['glucosePercentileByTime', 'glucoseGlycemiaRiskIndex', 'loopingPerformance', 'mealsTotalMeals'] });
    expect(html).toContain('No data for this range');
    expect(html).not.toContain('NaN');
  });

  it('uses mmol/mol for eA1c when asked', () => {
    const html = buildReportHtml({ snap, profile: DEFAULT_PROFILE, units: 'mg/dL', now: NOW, range: 'week', charts: ['glucosePercentileByTime'], eA1cMmolMol: true });
    expect(html).toContain('mmol/mol');
  });

  it('escapes html', () => {
    expect(esc('a<b>&"')).toBe('a&lt;b&gt;&amp;&quot;');
  });
});

describe('aggregateVisibleDays', () => {
  it('takes min/max across days and the median of each percentile', () => {
    const days = dailyGlucose(readings, NOW - 3 * 86_400_000, NOW);
    const agg = aggregateVisibleDays(days, { start: NOW - 3 * 86_400_000, end: NOW })!;
    expect(agg.min).toBe(Math.min(...days.filter((d) => d.count).map((d) => d.min)));
    expect(agg.max).toBe(Math.max(...days.filter((d) => d.count).map((d) => d.max)));
    expect(agg.median).toBeGreaterThan(0);
  });

  it('returns null when no visible day has data', () => {
    const days = dailyGlucose(readings, NOW - 3 * 86_400_000, NOW);
    expect(aggregateVisibleDays(days, { start: startOfDay(NOW) + 5 * 86_400_000, end: startOfDay(NOW) + 6 * 86_400_000 })).toBeNull();
  });
});
