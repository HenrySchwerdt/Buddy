import { router } from 'expo-router';
import { SymbolView, type SFSymbol } from '@/trio/symbol';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { CarbEntry } from '@buddy/core';
import { useSnapshot } from '@/runtime/hooks';
import { startGlucoseAlarmSync } from '@/features/settings-b/alarm-store';
import { startMealAbsorptionSync } from '@/features/settings-b/meal-absorption';
import { useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { CapsuleButton, Segmented, TrioScreen } from '@/trio';
import { useHistoryMode } from './actions';
import { recentAdjustments, startAdjustmentLog, useAdjustmentLog } from './adjustment-log';
import { CarbEntryEditor } from './carb-entry-editor';
import { AdjustmentsList, GlucoseList, MealsList, TreatmentsList } from './history-lists';
import { HISTORY_MODES, TREATMENT_TYPES, glucoseRows, mealRows, treatmentRows, type TreatmentType } from './rows';

startAdjustmentLog();
startMealAbsorptionSync();
startGlucoseAlarmSync();

/** Port of Trio's History.RootView. */
export function HistoryScreen() {
  const snap = useSnapshot();
  const now = useRuntime((s) => s.now);
  const units = useSettings((s) => s.units);
  const override = useSettings((s) => s.override);
  const tempTarget = useSettings((s) => s.tempTarget);
  const runs = useAdjustmentLog((s) => s.runs);
  const { mode, setMode } = useHistoryMode();

  const [filter, setFilter] = useState<ReadonlySet<TreatmentType>>(() => new Set(TREATMENT_TYPES.map((t) => t.value)));
  const [showFuture, setShowFuture] = useState(false);
  const [editing, setEditing] = useState<CarbEntry | null>(null);

  const treatments = useMemo(() => treatmentRows(snap.doses, now), [snap.doses, now]);
  const meals = useMemo(() => mealRows(snap.carbs, now, showFuture), [snap.carbs, now, showFuture]);
  const glucose = useMemo(() => glucoseRows(snap.glucose, now), [snap.glucose, now]);
  const adjustments = useMemo(() => recentAdjustments(runs, override, tempTarget, now), [runs, override, tempTarget, now]);

  return (
    <TrioScreen
      title="History"
      leading={<CapsuleButton label="Statistics" icon="chart.bar.xaxis" iconFirst onPress={() => router.push('/statistics')} />}
      trailing={<CapsuleButton label="Add Glucose" icon="plus" onPress={() => router.push('/add-glucose')} />}>
      <Segmented options={HISTORY_MODES} value={mode} onChange={setMode} />
      <View style={styles.list}>
        {mode === 'treatments' ? <TreatmentsList rows={treatments} filter={filter} onFilterChange={setFilter} /> : null}
        {mode === 'meals' ? <MealsList rows={meals} showFuture={showFuture} onToggleFuture={() => setShowFuture((v) => !v)} onEdit={setEditing} /> : null}
        {mode === 'glucose' ? <GlucoseList rows={glucose} units={units} /> : null}
        {mode === 'adjustments' ? <AdjustmentsList runs={adjustments} units={units} /> : null}
      </View>
      <CarbEntryEditor entry={editing} onClose={() => setEditing(null)} />
    </TrioScreen>
  );
}

const styles = StyleSheet.create({
  capsule: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, height: 44 },
  list: { marginTop: 16 },
});
