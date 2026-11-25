import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { G, Line, Rect } from 'react-native-svg';
import type { GlucoseReading, GlucoseUnit } from '@buddy/core';
import { T } from '@/trio';
import { dailyGlucose, distributionBands, intervalStart, type Bucket, type Interval } from './calc';
import { BAND_COLORS, bandLegend } from './glucose-distribution-chart';
import { DYN, SYS, alpha, glucoseValue, inUnits, pctUpToOne } from './format';
import { bucketTitle, formatVisibleRange } from './range-label';
import { ScrollBarChart } from './scroll-bar-chart';
import { ChartPopover, Divider, Legend, Row } from './ui';

interface Props {
  readonly readings: readonly GlucoseReading[];
  readonly units: GlucoseUnit;
  readonly bottom: number;
  readonly top: number;
  readonly highLimit: number;
  readonly interval: Interval;
  readonly now: number;
}

const BOX = ['min', 'p10', 'p25', 'median', 'p75', 'p90', 'max'] as const;

/** GlucoseDailyPercentileChart: one box plot per day (10/25/50/75/90 %). */
export function GlucoseDailyPercentileChart({ readings, units, bottom, highLimit, interval, now }: Props) {
  const days = useMemo(() => dailyGlucose(readings, intervalStart('total', now), now), [readings, now]);
  const buckets: Bucket[] = days.map((d) => ({ date: d.day, values: BOX.map((k) => d[k]) }));
  const [range, setRange] = useState({ start: now, end: now });
  const maxV = Math.max(highLimit, ...days.map((d) => d.p90));
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T style_="footnote">{units}</T>
        <T style_="callout" secondary>
          {formatVisibleRange(range.start, range.end, interval)}
        </T>
      </Row>
      <ScrollBarChart
        buckets={buckets}
        interval={interval}
        now={now}
        height={220}
        colors={[SYS.blue]}
        yDomain={[inUnits(40, units), inUnits(maxV, units)]}
        yLabel={(v) => (units === 'mg/dL' ? v.toFixed(0) : v.toFixed(1))}
        onRangeChange={setRange}
        accessibilityLabel="Daily glucose percentile chart"
        renderBar={(b, x, w, y, dim) => {
          const [, p10, p25, med, p75, p90] = b.values.map((v) => inUnits(v, units));
          if (!med) return null;
          const cx = x + w / 2;
          const o = dim ? 0.3 : 1;
          return (
            <G opacity={o}>
              <Line x1={cx} x2={cx} y1={y(p90!)} y2={y(p10!)} stroke={alpha(SYS.blue, 0.6)} strokeWidth={1} />
              <Rect x={x} y={y(p75!)} width={w} height={Math.max(1, y(p25!) - y(p75!))} fill={alpha(SYS.blue, 0.5)} />
              <Line x1={x} x2={x + w} y1={y(med)} y2={y(med)} stroke={SYS.blue} strokeWidth={2} />
            </G>
          );
        }}
        popover={(b) => (
          <ChartPopover>
            <T style_="subheadline" weight="700" secondary>
              {bucketTitle(b.date, interval)}
            </T>
            <Divider />
            {(
              [
                ['90%:', b.values[5]],
                ['75%:', b.values[4]],
                ['Median:', b.values[3]],
                ['25%:', b.values[2]],
                ['10%:', b.values[1]],
              ] as const
            ).map(([l, v]) => (
              <Row key={l} style={{ gap: 6 }}>
                <T style_="footnote" weight="700">
                  {l}
                </T>
                <T style_="footnote">{`${glucoseValue(v ?? 0, units)} ${units}`}</T>
              </Row>
            ))}
          </ChartPopover>
        )}
      />
      <Legend
        columns={3}
        items={[
          { label: '10-90%', color: alpha(SYS.blue, 0.6) },
          { label: '25-75%', color: alpha(SYS.blue, 0.5) },
          { label: 'Median', color: SYS.blue },
          { label: `${glucoseValue(bottom, units)} ${units}`, color: DYN.red },
          { label: `${glucoseValue(highLimit, units)} ${units}`, color: DYN.purple },
        ]}
      />
    </View>
  );
}

/** GlucoseDailyDistributionChart: one 100 % stacked bar per day. */
export function GlucoseDailyDistributionChart({ readings, units, bottom, top, interval, now }: Props) {
  const bands = distributionBands(bottom, top);
  const days = useMemo(() => dailyGlucose(readings, intervalStart('total', now), now, bottom, top), [readings, now, bottom, top]);
  const buckets: Bucket[] = days.map((d) => ({ date: d.day, values: bands.map((b) => d.bands[b.key] ?? 0) }));
  const [range, setRange] = useState({ start: now, end: now });
  const legend = bandLegend(units, bottom, top);
  return (
    <View style={{ gap: 8 }}>
      <T style_="callout" secondary align="right">
        {formatVisibleRange(range.start, range.end, interval)}
      </T>
      <ScrollBarChart
        buckets={buckets}
        interval={interval}
        now={now}
        height={220}
        normalized
        colors={bands.map((b) => BAND_COLORS[b.key]!)}
        onRangeChange={setRange}
        accessibilityLabel="Daily glucose distribution chart"
        popover={(b) => (
          <ChartPopover>
            <T style_="subheadline" weight="700" secondary>
              {bucketTitle(b.date, interval)}
            </T>
            <Divider />
            {[...legend].reverse().map((l, i) => (
              <Row key={l.label} style={{ gap: 6, justifyContent: 'space-between' }}>
                <T style_="footnote" color={l.color}>
                  {l.label}
                </T>
                <T style_="footnote">{pctUpToOne(b.values[legend.length - 1 - i] ?? 0)}</T>
              </Row>
            ))}
          </ChartPopover>
        )}
      />
      <Legend columns={4} items={legend} />
    </View>
  );
}
