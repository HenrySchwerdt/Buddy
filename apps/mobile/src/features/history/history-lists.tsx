import { SymbolView } from 'expo-symbols';
import { Pressable, View } from 'react-native';
import { toMmol, type CarbEntry, type GlucoseReading, type GlucoseUnit } from '@buddy/core';
import { Row, Section, T, useTrioColors } from '@/trio';
import { deleteCarbs, deleteGlucose } from './actions';
import type { AdjustmentRun } from './adjustment-log';
import { Dot, NoData, SwipeRow, confirmDelete } from './list-parts';
import { MANUAL_SOURCE, TREND_SYMBOL, glucoseKey, timeOfDay, upTo2, type MealRow, type TreatmentRow, type TreatmentType } from './rows';
import { TreatmentFilter } from './treatment-filter';

const fmtGlucose = (mgdl: number, units: GlucoseUnit) => (units === 'mg/dL' ? String(Math.round(mgdl)) : new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(toMmol(mgdl)));

function Time({ t }: { t: number }) {
  return <T>{timeOfDay(t)}</T>;
}

/** HistoryRootView+Treatments. */
export function TreatmentsList({ rows, filter, onFilterChange }: { rows: readonly TreatmentRow[]; filter: ReadonlySet<TreatmentType>; onFilterChange: (s: ReadonlySet<TreatmentType>) => void }) {
  const c = useTrioColors();
  const visible = rows.filter((r) => filter.has(r.type));
  const dot = { insulin: c.insulin, tempBasal: `${c.insulin}66`, gray: c.loopGray };
  return (
    <Section>
      <Row>
        <TreatmentFilter selected={filter} onChange={onFilterChange} />
        <View style={{ flex: 1 }} />
        <T secondary>Time</T>
      </Row>
      {visible.length === 0 ? (
        <NoData icon="syringe" />
      ) : (
        visible.map((r) => (
          <Row key={r.id} accessibilityLabel={`${r.title} ${r.amount ?? ''} ${r.duration ?? ''}, ${timeOfDay(r.date)}`}>
            <Dot color={dot[r.dot]} />
            <T>{r.title}</T>
            {r.amount ? <T secondary>{r.amount}</T> : null}
            {r.duration ? <T secondary>{r.duration}</T> : null}
            <View style={{ flex: 1 }} />
            <Time t={r.date} />
          </Row>
        ))
      )}
    </Section>
  );
}

/** HistoryRootView+Meals. */
export function MealsList({ rows, showFuture, onToggleFuture, onEdit }: { rows: readonly MealRow[]; showFuture: boolean; onToggleFuture: () => void; onEdit: (e: CarbEntry) => void }) {
  const c = useTrioColors();
  return (
    <Section>
      <Row>
        <T secondary>Type</T>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onToggleFuture} accessibilityRole="button" style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, opacity: pressed ? 0.5 : 1 })}>
          <T color={c.tabBar}>{showFuture ? 'Hide Future' : 'Show Future'}</T>
          <SymbolView name={showFuture ? 'eye.slash' : 'eye'} size={18} tintColor={c.tabBar} />
        </Pressable>
      </Row>
      {rows.length === 0 ? (
        <NoData icon="fork.knife" />
      ) : (
        rows.map((m) => (
          <SwipeRow
            key={m.id}
            actions={[
              {
                label: 'Delete',
                icon: 'trash.fill',
                color: c.red,
                onPress: () => confirmDelete('Delete Carbs?', `${timeOfDay(m.date)}, ${upTo2(m.entry.grams)} g`, () => deleteCarbs(m.entry)),
              },
              { label: 'Edit', icon: 'pencil', color: c.accent, onPress: () => onEdit(m.entry) },
            ]}>
            <Row accessibilityLabel={`Carbs ${m.amount}, ${timeOfDay(m.date)}`}>
              <Dot color={c.loopYellow} />
              <T>Carbs</T>
              <T>{m.amount}</T>
              <View style={{ flex: 1 }} />
              <Time t={m.date} />
            </Row>
          </SwipeRow>
        ))
      )}
    </Section>
  );
}

/** HistoryRootView+Glucose. */
export function GlucoseList({ rows, units }: { rows: readonly GlucoseReading[]; units: GlucoseUnit }) {
  const c = useTrioColors();
  return (
    <Section>
      <Row>
        <T secondary>Values</T>
        <View style={{ flex: 1 }} />
        <T secondary>Time</T>
      </Row>
      {rows.length === 0 ? (
        <NoData icon="drop.fill" />
      ) : (
        rows.map((g) => {
          const manual = g.source === MANUAL_SOURCE;
          const value = fmtGlucose(g.value, units);
          return (
            <SwipeRow
              key={glucoseKey(g)}
              actions={[
                {
                  label: 'Delete',
                  icon: 'trash.fill',
                  color: c.red,
                  onPress: () => confirmDelete('Delete Glucose?', `${timeOfDay(g.date)}, ${value} ${units}`, () => deleteGlucose(g)),
                },
              ]}>
              <Row accessibilityLabel={`${value}, ${manual ? 'manual entry' : g.trend ? TREND_SYMBOL[g.trend] : '--'}, ${timeOfDay(g.date)}`}>
                <T>{value}</T>
                {manual ? <SymbolView name="drop.fill" size={16} tintColor={c.red} /> : <T>{g.trend ? TREND_SYMBOL[g.trend] : '--'}</T>}
                <View style={{ flex: 1 }} />
                <Time t={g.date} />
              </Row>
            </SwipeRow>
          );
        })
      )}
    </Section>
  );
}

function timeRange(a: number, b: number) {
  return `${timeOfDay(a)} - ${timeOfDay(b)}`;
}

/** HistoryRootView+Adjustments. */
export function AdjustmentsList({ runs, units }: { runs: readonly AdjustmentRun[]; units: GlucoseUnit }) {
  const c = useTrioColors();
  return (
    <Section>
      <Row>
        <T secondary>Adjustment</T>
      </Row>
      {runs.length === 0 ? (
        <NoData icon="clock.arrow.2.circlepath" />
      ) : (
        runs.map((r) => {
          const labels = [r.target ? `${fmtGlucose(r.target, units)} ${units}` : '', timeRange(r.startDate, r.endDate)].filter((l) => l !== '');
          return (
            <Row key={r.id} style={{ paddingVertical: 20 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <SymbolView name={r.kind === 'override' ? 'clock.arrow.2.circlepath' : 'target'} size={18} tintColor={r.kind === 'override' ? c.purple : c.green} />
                  <T style_="headline">{r.name}</T>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
                  {labels.map((l, i) => (
                    <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <T style_="caption" secondary>
                        {l}
                      </T>
                      {i < labels.length - 1 ? <View style={{ width: 1, height: 12, backgroundColor: c.separator }} /> : null}
                    </View>
                  ))}
                </View>
              </View>
            </Row>
          );
        })
      )}
    </Section>
  );
}
