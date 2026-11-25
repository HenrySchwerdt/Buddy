import { useMemo } from 'react';
import type { GlucoseReading, GlucoseUnit } from '@buddy/core';
import { Segmented } from '@/trio';
import { INTERVALS_WITH_TODAY, glucoseRangeStats, gri, hourOf, hourlyStats, intervalStart, type Interval, type IntervalWithToday } from './calc';
import { GlucoseDailyDistributionChart, GlucoseDailyPercentileChart } from './glucose-daily-charts';
import { GlucoseDistributionChart } from './glucose-distribution-chart';
import { GlucoseMetrics } from './glucose-metrics';
import { GlucosePercentileChart } from './glucose-percentile-chart';
import { GlucoseSectorChart } from './glucose-sector-chart';
import { GriChart, GriExplanation } from './gri-view';
import { ChartTypeRow, Divider, Hint, StatCard, Unavailable } from './ui';

export type GlucoseChartType = 'percentile' | 'distribution' | 'gri' | 'percentileByDay' | 'distributionByDay';
export const GLUCOSE_CHART_TYPES = [
  { value: 'percentile', label: 'Percentile' },
  { value: 'distribution', label: 'Distribution' },
  { value: 'gri', label: 'Glycemia Risk Index' },
  { value: 'percentileByDay', label: 'Percentile (by day)' },
  { value: 'distributionByDay', label: 'Distribution (by day)' },
] as const satisfies readonly { value: GlucoseChartType; label: string }[];

const isByDay = (t: GlucoseChartType) => t === 'percentileByDay' || t === 'distributionByDay';

const HINTS: Record<GlucoseChartType, string | null> = {
  gri: null,
  percentile: 'Tap and hold the AGP graph or Time-in-Range ring to reveal more details.',
  distribution: 'Tap and hold the Time-in-Range ring to reveal more details.',
  percentileByDay: 'Tap a percentile or tap and hold a bar to reveal more details. Swipe to scroll through time.',
  distributionByDay: 'Tap and hold a bar in the chart to reveal more details. Swipe to scroll through time.',
};

/** Trio's thresholds: TimeInRangeType.timeInTightRange (70/140) and highLimit 180. */
const BOTTOM = 70;
const TOP = 140;
const HIGH_LIMIT = 180;

interface Props {
  readonly type: GlucoseChartType;
  readonly onTypeChange: (t: GlucoseChartType) => void;
  readonly interval: IntervalWithToday;
  readonly onIntervalChange: (i: IntervalWithToday) => void;
  readonly glucose: readonly GlucoseReading[];
  readonly units: GlucoseUnit;
  readonly now: number;
}

/** StatRootView.glucoseView. */
export function GlucoseStats({ type, onTypeChange, interval, onIntervalChange, glucose, units, now }: Props) {
  const readings = useMemo(() => {
    const from = intervalStart(interval, now);
    return glucose.filter((g) => g.date >= from && g.date <= now);
  }, [glucose, interval, now]);
  const hourly = useMemo(() => hourlyStats(readings), [readings]);
  const ranges = useMemo(() => glucoseRangeStats(readings, BOTTOM, TOP), [readings]);
  const griResult = useMemo(() => (type === 'gri' ? gri(readings) : null), [type, readings]);

  const options = isByDay(type) ? INTERVALS_WITH_TODAY.filter((o) => o.value === 'week' || o.value === 'month' || o.value === 'total') : INTERVALS_WITH_TODAY;
  const changeType = (t: GlucoseChartType) => {
    // Switching to a by-day chart while D/Today is selected falls back to W (Trio).
    if (isByDay(t) && (interval === 'day' || interval === 'today')) onIntervalChange('week');
    onTypeChange(t);
  };
  const dayInterval = (interval === 'today' || interval === 'day' ? 'week' : interval) as Interval;
  const hint = HINTS[type];

  return (
    <>
      <ChartTypeRow title="Glucose Chart Type" value={type} options={GLUCOSE_CHART_TYPES} onChange={changeType} />
      <Segmented options={options} value={interval} onChange={onIntervalChange} />
      {readings.length === 0 ? (
        <Unavailable title="No Glucose Data" icon="chart.bar.fill" description="Glucose statistics will appear here once data is available." />
      ) : (
        <>
          <StatCard>
            {type === 'percentile' ? (
              <GlucosePercentileChart stats={hourly} units={units} bottom={BOTTOM} top={TOP} highLimit={HIGH_LIMIT} isToday={interval === 'today'} nowHour={hourOf(now)} />
            ) : null}
            {type === 'distribution' ? <GlucoseDistributionChart ranges={ranges} units={units} bottom={BOTTOM} top={TOP} /> : null}
            {type === 'gri' ? <GriChart result={griResult} /> : null}
            {type === 'percentileByDay' ? (
              <GlucoseDailyPercentileChart readings={glucose} units={units} bottom={BOTTOM} top={TOP} highLimit={HIGH_LIMIT} interval={dayInterval} now={now} />
            ) : null}
            {type === 'distributionByDay' ? (
              <GlucoseDailyDistributionChart readings={glucose} units={units} bottom={BOTTOM} top={TOP} highLimit={HIGH_LIMIT} interval={dayInterval} now={now} />
            ) : null}
          </StatCard>
          {type === 'gri' ? (
            <StatCard>
              <GriExplanation result={griResult} />
            </StatCard>
          ) : null}
          {type !== 'gri' && !isByDay(type) ? (
            <StatCard>
              <GlucoseSectorChart readings={readings} units={units} bottom={BOTTOM} top={TOP} highLimit={HIGH_LIMIT} />
              <Divider />
              <GlucoseMetrics readings={readings} units={units} />
            </StatCard>
          ) : null}
          {hint ? <Hint lines={[hint]} /> : null}
        </>
      )}
    </>
  );
}
