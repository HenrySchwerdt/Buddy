import { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { DataSnapshot, TherapyProfile } from '@buddy/core';
import { T, useTrioColors } from '@/trio';
import { averageOverDays, bolusBuckets, sumInRange, tddBuckets, type Bucket, type Interval } from './calc';
import { SYS, fixed } from './format';
import { bucketTitle, formatVisibleRange } from './range-label';
import { ScrollBarChart } from './scroll-bar-chart';
import { ChartPopover, Divider, Legend, Row, StatCard, Unavailable } from './ui';

export type InsulinChartType = 'tdd' | 'bolus';
export const INSULIN_CHART_TYPES = [
  { value: 'tdd', label: 'Total Daily Dose' },
  { value: 'bolus', label: 'Bolus Distribution' },
] as const satisfies readonly { value: InsulinChartType; label: string }[];

const U = ' U';
const GRID_LABEL_W = 92;

function GridRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <T style_="headline" style={{ minWidth: GRID_LABEL_W }}>
        {label}
      </T>
      <T style_="headline">{value}</T>
    </Row>
  );
}

function RangeText({ text }: { text: string }) {
  return (
    <T style_="callout" secondary align="right" style={{ flexShrink: 1 }}>
      {text}
    </T>
  );
}

function Popover({ b, interval, rows, color }: { b: Bucket; interval: Interval; rows: readonly [string, number][]; color: string }) {
  return (
    <ChartPopover color={color}>
      <T style_="subheadline" weight="700" secondary>
        {bucketTitle(b.date, interval)}
      </T>
      <Divider />
      {rows.map(([label, v]) => (
        <Row key={label} style={{ gap: 6 }}>
          {label ? <T style_="headline">{label}</T> : null}
          <T style_="headline">{fixed(v, 1)}</T>
          <T style_="headline" secondary>
            U
          </T>
        </Row>
      ))}
    </ChartPopover>
  );
}

/** TotalDailyDoseChart. */
function TddChart({ snap, profile, interval, now }: { snap: DataSnapshot; profile: TherapyProfile; interval: Interval; now: number }) {
  const c = useTrioColors();
  const buckets = useMemo(() => tddBuckets(snap.doses, profile, interval, now), [snap.doses, profile, interval, now]);
  const [range, setRange] = useState({ start: now, end: now });
  const average = averageOverDays(buckets, interval, range);
  const total = sumInRange(buckets, range, 0);
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ marginBottom: 16, gap: 8 }}>
        <View style={{ flex: 1 }}>
          {interval === 'day' ? (
            <>
              <GridRow label="Average:" value={`${fixed(average, 1)}${U}`} />
              <GridRow label="Total:" value={`${fixed(total, 1)}${U}`} />
            </>
          ) : (
            <T style_="headline">{`Average: ${fixed(average, 1)}${U}`}</T>
          )}
        </View>
        <RangeText text={formatVisibleRange(range.start, range.end, interval)} />
      </Row>
      <T style_="footnote" secondary align="right" style={{ marginBottom: 4 }}>
        Total Daily Dose (U)
      </T>
      <ScrollBarChart
        buckets={buckets}
        interval={interval}
        now={now}
        colors={[c.insulin]}
        onRangeChange={setRange}
        accessibilityLabel="Total daily dose bar chart"
        popover={(b) => <Popover b={b} interval={interval} rows={[['', b.values[0] ?? 0]]} color={SYS.blue} />}
      />
    </View>
  );
}

const BOLUS_COLORS = [SYS.teal, SYS.blue, SYS.purple];

/** BolusStatsView: manual / SMB / external stacked per bucket. */
function BolusChart({ interval, now, buckets }: { interval: Interval; now: number; buckets: readonly Bucket[] }) {
  const [range, setRange] = useState({ start: now, end: now });
  const avg = (i: number) => averageOverDays(buckets, interval, range, i);
  const prefix = interval === 'day' ? '' : 'ø ';
  const totalBuckets = buckets.map((b) => ({ date: b.date, values: [b.values.reduce((a, v) => a + v, 0)] }));
  const total = interval === 'day' ? sumInRange(buckets, range) : averageOverDays(totalBuckets, interval, range);
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ marginBottom: 16, gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <GridRow label={`${prefix}Manual:`} value={`${fixed(avg(0), 1)}${U}`} />
          <GridRow label={`${prefix}SMB:`} value={`${fixed(avg(1), 1)}${U}`} />
          <GridRow label={`${prefix}External:`} value={`${fixed(avg(2), 1)}${U}`} />
          <Divider />
          <GridRow label="Total:" value={`${fixed(total, 1)}${U}`} />
        </View>
        <RangeText text={formatVisibleRange(range.start, range.end, interval)} />
      </Row>
      <T style_="footnote" secondary align="right" style={{ marginBottom: 4 }}>
        Bolus Insulin (U)
      </T>
      <ScrollBarChart
        buckets={buckets}
        interval={interval}
        now={now}
        colors={BOLUS_COLORS}
        onRangeChange={setRange}
        accessibilityLabel="Bolus insulin bar chart"
        popover={(b) => (
          <Popover
            b={b}
            interval={interval}
            color={SYS.blue}
            rows={[
              ['Manual:', b.values[0] ?? 0],
              ['SMB:', b.values[1] ?? 0],
              ['External:', b.values[2] ?? 0],
              ['Total:', b.values.reduce((a, v) => a + v, 0)],
            ]}
          />
        )}
      />
      <Legend
        columns={3}
        items={[
          { label: 'SMB', color: SYS.blue },
          { label: 'Manual', color: SYS.teal },
          { label: 'External', color: SYS.purple },
        ]}
      />
    </View>
  );
}

export function InsulinStats({ type, snap, profile, interval, now }: { type: InsulinChartType; snap: DataSnapshot; profile: TherapyProfile; interval: Interval; now: number }) {
  const bolus = useMemo(() => bolusBuckets(snap.doses, interval, now), [snap.doses, interval, now]);
  if (type === 'tdd') {
    return (
      <StatCard>
        <TddChart snap={snap} profile={profile} interval={interval} now={now} />
      </StatCard>
    );
  }
  const hasBolus = bolus.some((b) => b.values.some((v) => v > 0));
  return (
    <StatCard>
      {hasBolus ? (
        <BolusChart interval={interval} now={now} buckets={bolus} />
      ) : (
        <Unavailable title="No Bolus Data" icon="cross.vial" description="Bolus statistics will appear here once data is available." />
      )}
    </StatCard>
  );
}
