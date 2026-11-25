import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, ScrollView, Share, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSnapshot } from '@/runtime/hooks';
import { useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, Segmented, SheetScreen, useTrioColors } from '@/trio';
import { INTERVALS, INTERVALS_WITH_TODAY, loopStats, type Interval, type IntervalWithToday } from './calc';
import { GlucoseStats, type GlucoseChartType } from './glucose-stats';
import { INSULIN_CHART_TYPES, InsulinStats, type InsulinChartType } from './insulin-stats';
import { LOOPING_CHART_TYPES, LoopingStats, type LoopingChartType } from './looping-stats';
import { MEAL_CHART_TYPES, MealStats, type MealChartType } from './meal-stats';
import { buildStatsReport } from './report';
import { ChartTypeRow, Hint } from './ui';

type View_ = 'glucose' | 'insulin' | 'looping' | 'meals';
const VIEWS = [
  { value: 'glucose', label: 'Glucose' },
  { value: 'insulin', label: 'Insulin' },
  { value: 'looping', label: 'Looping' },
  { value: 'meals', label: 'Meals' },
] as const satisfies readonly { value: View_; label: string }[];

const SWIPE_HINT = ['Swipe the chart to scroll through time.', 'Tap and hold a bar to reveal more details.'];

/** Port of Trio's Stat.RootView. */
export function StatisticsScreen() {
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  const snap = useSnapshot();
  const now = useRuntime((s) => s.now);
  const units = useSettings((s) => s.units);
  const profile = useSettings((s) => s.profile);

  const [view, setView] = useState<View_>('glucose');
  const [glucoseType, setGlucoseType] = useState<GlucoseChartType>('percentile');
  const [glucoseInterval, setGlucoseInterval] = useState<IntervalWithToday>('today');
  const [insulinType, setInsulinType] = useState<InsulinChartType>('tdd');
  const [insulinInterval, setInsulinInterval] = useState<Interval>('day');
  const [loopType, setLoopType] = useState<LoopingChartType>('performance');
  const [loopInterval, setLoopInterval] = useState<IntervalWithToday>('today');
  const [mealType, setMealType] = useState<MealChartType>('total');
  const [mealInterval, setMealInterval] = useState<Interval>('day');

  const loop = useMemo(() => loopStats(snap.loopRuns, snap.glucose, loopInterval, now), [snap.loopRuns, snap.glucose, loopInterval, now]);

  const share = async () => {
    try {
      await Share.share({ title: 'Statistics', message: buildStatsReport(snap, profile, units, now) });
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SheetScreen
      title="Statistics"
      scroll={false}
      leading={<CapsuleButton label="Close" color={c.tabBar} onPress={() => router.back()} />}
      trailing={<CapsuleButton icon="square.and.arrow.up" onPress={() => void share()} accessibilityLabel="Export statistics" />}>
      <Segmented options={VIEWS} value={view} onChange={setView} />
      <ScrollView style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 16, paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
        {view === 'glucose' ? (
          <GlucoseStats type={glucoseType} onTypeChange={setGlucoseType} interval={glucoseInterval} onIntervalChange={setGlucoseInterval} glucose={snap.glucose} units={units} now={now} />
        ) : null}
        {view === 'insulin' ? (
          <>
            <ChartTypeRow title="Insulin Chart Type" value={insulinType} options={INSULIN_CHART_TYPES} onChange={setInsulinType} />
            <Segmented options={INTERVALS} value={insulinInterval} onChange={setInsulinInterval} />
            <InsulinStats type={insulinType} snap={snap} profile={profile} interval={insulinInterval} now={now} />
            <Hint lines={SWIPE_HINT} />
          </>
        ) : null}
        {view === 'looping' ? (
          <>
            <ChartTypeRow title="Looping Chart Type" value={loopType} options={LOOPING_CHART_TYPES} onChange={setLoopType} />
            <Segmented options={INTERVALS_WITH_TODAY} value={loopInterval} onChange={setLoopInterval} />
            <LoopingStats type={loopType} data={loop} interval={loopInterval} />
          </>
        ) : null}
        {view === 'meals' ? (
          <>
            <ChartTypeRow title="Meal Chart Type" value={mealType} options={MEAL_CHART_TYPES} onChange={setMealType} />
            <Segmented options={INTERVALS} value={mealInterval} onChange={setMealInterval} />
            <MealStats type={mealType} carbs={snap.carbs} interval={mealInterval} now={now} />
            <Hint lines={SWIPE_HINT} />
          </>
        ) : null}
        <View />
      </ScrollView>
    </SheetScreen>
  );
}
