import { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { CarbEntry } from '@buddy/core';
import { T } from '@/trio';
import { averageOverDays, mealBuckets, type Interval } from './calc';
import { SYS, fixed } from './format';
import { bucketTitle, formatVisibleRange } from './range-label';
import { ScrollBarChart } from './scroll-bar-chart';
import { ChartPopover, Divider, Legend, Row, StatCard, Unavailable } from './ui';

export type MealChartType = 'total' | 'hypoHyper';
export const MEAL_CHART_TYPES = [
  { value: 'total', label: 'Total Meals' },
  { value: 'hypoHyper', label: 'Meal to Hypo/Hyper' },
] as const satisfies readonly { value: MealChartType; label: string }[];

/** MealStatsView (Buddy records carbs only, i.e. Trio with FPU conversion off). */
function MealChart({ carbs, interval, now }: { carbs: readonly CarbEntry[]; interval: Interval; now: number }) {
  const buckets = useMemo(() => mealBuckets(carbs, interval, now), [carbs, interval, now]);
  const [range, setRange] = useState({ start: now, end: now });
  const hasData = buckets.some((b) => (b.values[0] ?? 0) > 0);
  if (!hasData) return <Unavailable title="No Meal Data" icon="fork.knife" description="Meal statistics will appear here once data is available." />;
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ marginBottom: 16, gap: 8 }}>
        <T style_="headline" style={{ flex: 1 }}>{`Carbs: ${fixed(averageOverDays(buckets, interval, range), 1)} g`}</T>
        <T style_="callout" secondary align="right">
          {formatVisibleRange(range.start, range.end, interval)}
        </T>
      </Row>
      <T style_="footnote" secondary align="right" style={{ marginBottom: 4 }}>
        Macro Nutrients (g)
      </T>
      <ScrollBarChart
        buckets={buckets}
        interval={interval}
        now={now}
        colors={[SYS.orange]}
        onRangeChange={setRange}
        accessibilityLabel="Meal macronutrients bar chart"
        popover={(b) => (
          <ChartPopover color={SYS.orange}>
            <T style_="subheadline" weight="700" secondary>
              {bucketTitle(b.date, interval)}
            </T>
            <Divider />
            <Row style={{ gap: 6 }}>
              <T style_="headline">Carbs:</T>
              <T style_="headline">{fixed(b.values[0] ?? 0, 1)}</T>
              <T style_="headline" secondary>
                g
              </T>
            </Row>
          </ChartPopover>
        )}
      />
      <Legend columns={3} items={[{ label: 'Carbs', color: SYS.orange }]} />
    </View>
  );
}

export function MealStats({ type, carbs, interval, now }: { type: MealChartType; carbs: readonly CarbEntry[]; interval: Interval; now: number }) {
  return (
    <StatCard>
      {type === 'total' ? (
        <MealChart carbs={carbs} interval={interval} now={now} />
      ) : (
        <Unavailable title="Coming soon." icon="hourglass" description="Meal to Hypo/Hyper" />
      )}
    </StatCard>
  );
}
