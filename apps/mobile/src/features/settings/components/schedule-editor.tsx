import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CapsuleButton, T, TAB_BAR_SPACE, TrioBackground, useTrioColors } from '@/trio';
import { closestIndex } from '../picker';
import { TherapyChart } from './therapy-chart';
import { WheelPicker } from './wheel-picker';

/** One schedule entry in display units. */
export interface EditorItem {
  readonly id: number;
  readonly minute: number;
  readonly value: number;
}

const STEP_MIN = 30;
const LAST_START = 23 * 60 + 30;
const MAX_ENTRIES = 48;
const TIME_OPTIONS = Array.from({ length: (24 * 60) / STEP_MIN }, (_, i) => i * STEP_MIN);

export const fmtMinute = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

interface Props {
  readonly title: string;
  readonly initial: readonly { minute: number; value: number }[];
  /** Picker options in display units. */
  readonly valueOptions: readonly number[];
  readonly formatValue: (v: number) => string;
  readonly unit: string;
  readonly chart: { color: string; fillsArea?: boolean; lineWidth?: number; yDomain?: readonly [number, number]; accessibilityLabel: string };
  readonly onSave: (items: readonly { minute: number; value: number }[]) => void;
  /** Content above the chart (profile banner, warnings). */
  readonly header?: ReactNode;
  /** Content under the entries (basal total). */
  readonly footer?: (items: readonly EditorItem[]) => ReactNode;
}

let nextId = 1;
const withIds = (xs: readonly { minute: number; value: number }[]): EditorItem[] => xs.map((x) => ({ ...x, id: nextId++ }));

/** Port of Trio's validateTherapySettingItems: unique start times, sorted, first at 00:00. */
export function normalizeItems(items: readonly EditorItem[]): EditorItem[] {
  const seen = new Set<number>();
  const sorted = [...items].sort((a, b) => a.minute - b.minute).filter((i) => (seen.has(i.minute) ? false : (seen.add(i.minute), true)));
  return sorted.map((it, i) => (i === 0 ? { ...it, minute: 0 } : it));
}

const sameItems = (a: readonly { minute: number; value: number }[], b: readonly { minute: number; value: number }[]) =>
  a.length === b.length && a.every((x, i) => x.minute === b[i]!.minute && x.value === b[i]!.value);

/**
 * Port of the Trio therapy editors (Basal/CR/ISF/Targets RootView + TherapySettingEditorView):
 * chart on top, "Entries" list with Add, tap a row for value/time wheels, swipe to delete,
 * Save bar at the bottom.
 */
export function ScheduleEditor({ title, initial, valueOptions, formatValue, unit, chart, onSave, header, footer }: Props) {
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  const [saved, setSaved] = useState(() => normalizeItems(withIds(initial)));
  const [items, setItems] = useState(saved);
  const [selected, setSelected] = useState<number | null>(null);
  const hasChanges = !sameItems(saved, items);
  const cannotAdd = items.length >= MAX_ENTRIES || (items.at(-1)?.minute ?? 0) >= LAST_START;

  const add = () => {
    const last = items.at(-1);
    const minute = Math.min((last?.minute ?? -STEP_MIN) + STEP_MIN, LAST_START);
    setSelected(null);
    setItems(normalizeItems([...items, { id: nextId++, minute, value: last?.value ?? valueOptions[0]! }]));
  };
  const remove = (id: number) => {
    if (items.length <= 1) return;
    setSelected(null);
    setItems(normalizeItems(items.filter((i) => i.id !== id)));
  };
  const change = (id: number, patch: Partial<EditorItem>) => setItems((xs) => normalizeItems(xs.map((x) => (x.id === id ? { ...x, ...patch } : x))));
  const save = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onSave(items.map(({ minute, value }) => ({ minute, value })));
    setSaved(items);
  };

  return (
    <View style={{ flex: 1 }}>
      <TrioBackground />
      <View style={{ paddingTop: insets.top }}>
        <View style={styles.toolbar}>
          <CapsuleButton icon="chevron.left" onPress={() => router.back()} accessibilityLabel="Back" />
        </View>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
        <T style_="largeTitle" style={{ marginLeft: 4, marginBottom: 8 }} accessibilityRole="header">
          {title}
        </T>
        {header}
        {items.length > 0 ? (
          <View style={[styles.chart, { backgroundColor: c.chart }]}>
            <TherapyChart entries={items} {...chart} formatY={(v) => formatValue(v)} />
          </View>
        ) : null}
        <View style={[styles.entriesHead, { backgroundColor: c.chart }, items.length === 0 && styles.roundTop]}>
          <T weight="700">Entries</T>
          <Pressable onPress={add} disabled={cannotAdd} accessibilityRole="button" style={({ pressed }) => [styles.add, { opacity: pressed ? 0.6 : 1 }]}>
            <SymbolView name="plus.circle.fill" size={22} tintColor={cannotAdd ? c.secondary : c.accent} />
            <T color={cannotAdd ? c.secondary : c.accent}>Add</T>
          </Pressable>
        </View>
        {items.map((item, index) => (
          <EntryRow
            key={item.id}
            item={item}
            first={index === 0}
            selected={selected === item.id}
            canDelete={items.length > 1}
            takenMinutes={items.filter((x) => x.id !== item.id).map((x) => x.minute)}
            valueOptions={valueOptions}
            formatValue={formatValue}
            unit={unit}
            onToggle={() => setSelected(selected === item.id ? null : item.id)}
            onChange={(patch) => change(item.id, patch)}
            onDelete={() => remove(item.id)}
          />
        ))}
        <View style={[styles.entriesFoot, { backgroundColor: c.chart }]} />
        {footer?.(items)}
        <View style={styles.swipeHint}>
          <SymbolView name="hand.draw.fill" size={18} tintColor={c.secondary} />
          <T style_="subheadline" secondary weight="300" style={{ flex: 1 }}>
            Swipe to delete a single entry. Tap on it, to edit its time or value.
          </T>
        </View>
      </ScrollView>
      <View style={[styles.saveBar, { backgroundColor: c.dark ? 'rgba(3,15,28,0.8)' : 'rgba(255,255,255,0.8)', paddingBottom: insets.bottom + TAB_BAR_SPACE - 40 }]}>
        <Pressable
          onPress={save}
          disabled={!hasChanges || items.length === 0}
          accessibilityRole="button"
          style={({ pressed }) => [styles.saveButton, { backgroundColor: hasChanges ? c.accent : c.dark ? '#3A3A3C' : '#D1D1D6', opacity: pressed ? 0.8 : 1 }]}>
          <T color={hasChanges ? '#FFFFFF' : c.secondary}>Save</T>
        </Pressable>
      </View>
    </View>
  );
}

interface RowProps {
  readonly item: EditorItem;
  readonly first: boolean;
  readonly selected: boolean;
  readonly canDelete: boolean;
  readonly takenMinutes: readonly number[];
  readonly valueOptions: readonly number[];
  readonly formatValue: (v: number) => string;
  readonly unit: string;
  readonly onToggle: () => void;
  readonly onChange: (patch: Partial<EditorItem>) => void;
  readonly onDelete: () => void;
}

function EntryRow({ item, first, selected, canDelete, takenMinutes, valueOptions, formatValue, unit, onToggle, onChange, onDelete }: RowProps) {
  const c = useTrioColors();
  const times = useMemo(() => TIME_OPTIONS.filter((m) => m === item.minute || !takenMinutes.includes(m)), [item.minute, takenMinutes]);
  const swipe = useRef<React.ComponentRef<typeof ReanimatedSwipeable>>(null);
  const label = `${formatValue(item.value)} ${unit}, starts at ${fmtMinute(item.minute)}`;
  const confirmDelete = () => {
    if (!canDelete) return;
    Alert.alert('Delete', label, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
  };
  return (
    <ReanimatedSwipeable
      ref={swipe}
      enabled={canDelete}
      friction={2}
      rightThreshold={40}
      renderRightActions={() => (
        <Pressable
          onPress={() => {
            swipe.current?.close();
            onDelete();
          }}
          accessibilityRole="button"
          style={[styles.delete, { backgroundColor: c.red }]}>
          <SymbolView name="trash" size={18} tintColor="#fff" />
          <T color="#fff">Delete</T>
        </Pressable>
      )}>
      <View style={{ backgroundColor: c.chart }}>
        <Pressable
          onPress={onToggle}
          onLongPress={confirmDelete}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Opens a picker to edit this entry"
          accessibilityActions={canDelete ? [{ name: 'delete', label: 'Delete' }] : []}
          onAccessibilityAction={onDelete}
          style={styles.entry}>
          <T color={selected ? c.accent : c.primary}>{formatValue(item.value)}</T>
          <T secondary style={{ flex: 1 }}>
            {unit}
          </T>
          <T secondary>starts at</T>
          <T color={selected ? c.accent : c.primary}>{fmtMinute(item.minute)}</T>
        </Pressable>
        {selected ? (
          <View style={styles.pickers}>
            <WheelPicker
              count={valueOptions.length}
              index={closestIndex(valueOptions, item.value)}
              label={(i) => `${formatValue(valueOptions[i]!)} ${unit}`}
              onChange={(i) => onChange({ value: valueOptions[i]! })}
              accessibilityLabel="Value"
            />
            <WheelPicker
              count={times.length}
              index={Math.max(0, times.indexOf(item.minute))}
              label={(i) => fmtMinute(times[i]!)}
              onChange={(i) => onChange({ minute: times[i]! })}
              disabled={first}
              accessibilityLabel="Time"
            />
          </View>
        ) : null}
        <View style={[styles.separator, { backgroundColor: c.separator }]} />
      </View>
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  toolbar: { paddingHorizontal: 16, height: 56, justifyContent: 'center' },
  chart: { padding: 16, borderTopLeftRadius: 10, borderTopRightRadius: 10, marginTop: 16 },
  roundTop: { borderTopLeftRadius: 10, borderTopRightRadius: 10, marginTop: 16 },
  entriesHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10 },
  add: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, minHeight: 45 },
  pickers: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 8 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  entriesFoot: { height: 10, borderBottomLeftRadius: 10, borderBottomRightRadius: 10, marginBottom: 16 },
  delete: { width: 96, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  swipeHint: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  saveBar: { paddingTop: 12, paddingHorizontal: 16, alignItems: 'center' },
  saveButton: { width: '95%', height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
