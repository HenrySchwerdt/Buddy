import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';
import type { Schedule } from '@buddy/core';
import { useTheme } from '@/theme/use-theme';
import { space } from '@/theme/tokens';
import { GlassPanel } from './glass-panel';
import { Text } from './text';

interface Props<T> {
  readonly title: string;
  readonly unit: string;
  readonly schedule: Schedule<T>;
  readonly onChange: (next: Schedule<T>) => void;
  /** Renders the editable value(s) for one entry. */
  readonly renderValue: (value: T, set: (v: T) => void) => React.ReactNode;
  readonly newValue: (previous: T) => T;
}

const STEP_MIN = 30;
const fmtMinute = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Edits a daily schedule (time-ordered entries starting at 00:00). Immutable updates only. */
export function ScheduleEditor<T>({ title, unit, schedule, onChange, renderValue, newValue }: Props<T>) {
  const theme = useTheme();
  const setAt = (i: number, patch: Partial<{ startMinute: number; value: T }>) => onChange(schedule.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const shift = (i: number, delta: number) => {
    const prev = schedule[i - 1]?.startMinute ?? -STEP_MIN;
    const next = schedule[i + 1]?.startMinute ?? 1440;
    const m = schedule[i]!.startMinute + delta;
    if (i === 0 || m <= prev || m >= next) return;
    void Haptics.selectionAsync();
    setAt(i, { startMinute: m });
  };
  const add = () => {
    const last = schedule.at(-1)!;
    if (last.startMinute + STEP_MIN >= 1440) return;
    onChange([...schedule, { startMinute: Math.min(1410, last.startMinute + 4 * 60 - ((last.startMinute + 240) % STEP_MIN)), value: newValue(last.value) }]);
  };
  return (
    <View style={{ gap: space.sm }}>
      <View style={styles.head}>
        <Text variant="overline" tone="faint">
          {title} · {unit}
        </Text>
        <Pressable onPress={add} accessibilityRole="button" accessibilityLabel={`Add ${title} entry`} hitSlop={8}>
          <SymbolView name="plus.circle.fill" size={22} tintColor={theme.accent} />
        </Pressable>
      </View>
      <GlassPanel padded={false}>
        {schedule.map((e, i) => (
          <View key={i} style={[styles.row, i < schedule.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.stroke }]}>
            <View style={styles.time}>
              <Pressable onPress={() => shift(i, -STEP_MIN)} disabled={i === 0} hitSlop={6} accessibilityLabel="Earlier">
                <SymbolView name="chevron.left" size={12} tintColor={i === 0 ? theme.textFaint : theme.text} />
              </Pressable>
              <Text variant="heading" style={{ fontVariant: ['tabular-nums'], width: 52, textAlign: 'center' }}>
                {fmtMinute(e.startMinute)}
              </Text>
              <Pressable onPress={() => shift(i, STEP_MIN)} disabled={i === 0} hitSlop={6} accessibilityLabel="Later">
                <SymbolView name="chevron.right" size={12} tintColor={i === 0 ? theme.textFaint : theme.text} />
              </Pressable>
            </View>
            <View style={{ flex: 1, alignItems: 'flex-end' }}>{renderValue(e.value, (v) => setAt(i, { value: v }))}</View>
            {i > 0 && (
              <Pressable onPress={() => onChange(schedule.filter((_, j) => j !== i))} hitSlop={8} accessibilityLabel="Remove entry">
                <SymbolView name="minus.circle.fill" size={20} tintColor={theme.danger} />
              </Pressable>
            )}
          </View>
        ))}
      </GlassPanel>
    </View>
  );
}

/** Small −/value/+ control for schedule values. */
export function MiniStepper({ value, step, min, max, decimals, onChange }: { value: number; step: number; min: number; max: number; decimals: number; onChange: (v: number) => void }) {
  const theme = useTheme();
  const set = (v: number) => {
    void Haptics.selectionAsync();
    onChange(Number(Math.min(max, Math.max(min, v)).toFixed(decimals)));
  };
  return (
    <View style={styles.mini}>
      <Pressable onPress={() => set(value - step)} hitSlop={6} style={[styles.miniBtn, { backgroundColor: theme.surfaceStrong }]} accessibilityLabel="Decrease">
        <SymbolView name="minus" size={11} tintColor={theme.text} weight="bold" />
      </Pressable>
      <Text variant="heading" style={{ fontVariant: ['tabular-nums'], minWidth: 48, textAlign: 'center' }}>
        {value.toFixed(decimals)}
      </Text>
      <Pressable onPress={() => set(value + step)} hitSlop={6} style={[styles.miniBtn, { backgroundColor: theme.surfaceStrong }]} accessibilityLabel="Increase">
        <SymbolView name="plus" size={11} tintColor={theme.text} weight="bold" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  time: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  mini: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  miniBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
