import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useTrioColors } from './colors';
import { SheetModal } from './sheet-modal';
import { T } from './text';

/*
 * Android stand-ins for the SwiftUI wheel and compact date picker. The iOS screens render the
 * native SwiftUI controls (1:1 with Trio); these draw the same wheels and capsules in JS.
 */

const ROW = 34;
const VISIBLE = 5;

export interface ListWheelOption<V extends number | string> {
  readonly value: V;
  readonly label: string;
}

/** Snapping list that behaves like `Picker(.wheel)`. */
export function ListWheel<V extends number | string>({ options, value, onChange, label }: { options: readonly ListWheelOption<V>[]; value: V; onChange: (v: V) => void; label: string }) {
  const c = useTrioColors();
  const list = useRef<ScrollViewInstance>(null);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  useEffect(() => {
    list.current?.scrollTo({ y: index * ROW, animated: false });
  }, [index]);
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.min(options.length - 1, Math.max(0, Math.round(e.nativeEvent.contentOffset.y / ROW)));
    const picked = options[i];
    if (picked && picked.value !== value) {
      void Haptics.selectionAsync();
      onChange(picked.value);
    }
  };
  const pad = ((VISIBLE - 1) / 2) * ROW;
  // A plain ScrollView (not a FlatList): the wheels live inside scrolling forms, and the option
  // lists are short enough that virtualization buys nothing.
  return (
    <View style={{ flex: 1, height: ROW * VISIBLE }} accessibilityLabel={label}>
      <View style={[styles.band, { top: pad, backgroundColor: c.fill }]} />
      <ScrollView
        ref={list}
        contentOffset={{ x: 0, y: index * ROW }}
        snapToInterval={ROW}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        contentContainerStyle={{ paddingVertical: pad }}
        onMomentumScrollEnd={settle}>
        {options.map((item, i) => (
          <Pressable key={String(item.value)} style={styles.row} onPress={() => list.current?.scrollTo({ y: i * ROW, animated: true })} accessibilityRole="button" accessibilityState={{ selected: item.value === value }}>
            <T style={{ fontSize: 20 }} secondary={item.value !== value}>
              {item.label}
            </T>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

type Mode = 'date' | 'time';

const pad2 = (n: number) => String(n).padStart(2, '0');
const range = (from: number, to: number, label: (n: number) => string = String): ListWheelOption<number>[] => Array.from({ length: to - from + 1 }, (_, i) => ({ value: from + i, label: label(from + i) }));
const MONTHS = Array.from({ length: 12 }, (_, m) => ({ value: m, label: new Date(2000, m, 1).toLocaleDateString([], { month: 'long' }) }));
const IS_12H = new Date(2000, 0, 1, 13).toLocaleTimeString([], { hour: 'numeric' }).toLowerCase().includes('pm');

/** Date and/or time capsules (the compact `DatePicker` look) that open a wheel sheet when tapped. */
export function DateTimeCapsules({ value, min, onChange, date = true, time = true }: { value: number; min?: number; onChange: (t: number) => void; date?: boolean; time?: boolean }) {
  const c = useTrioColors();
  const [open, setOpen] = useState<Mode | null>(null);
  const current = new Date(value);
  const capsule = (kind: Mode, text: string) => (
    <Pressable key={kind} onPress={() => setOpen(kind)} accessibilityRole="button" accessibilityLabel={text} style={({ pressed }) => [styles.capsule, { backgroundColor: c.fill, opacity: pressed ? 0.7 : 1 }]}>
      <T>{text}</T>
    </Pressable>
  );
  return (
    <View style={styles.capsules}>
      {date ? capsule('date', current.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })) : null}
      {time ? capsule('time', current.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null}
      {open ? <WheelSheet mode={open} value={value} min={min} onClosed={() => setOpen(null)} onCommit={(t) => onChange(Math.max(min ?? -Infinity, t))} /> : null}
    </View>
  );
}

/** Bottom sheet with date (month, day, year) or time (hour, minute) wheels and a Done button. */
function WheelSheet({ mode, value, min, onClosed, onCommit }: { mode: Mode; value: number; min?: number; onClosed: () => void; onCommit: (t: number) => void }) {
  const c = useTrioColors();
  const [draft, setDraft] = useState(new Date(value));
  const set = (patch: (d: Date) => void) =>
    setDraft((d) => {
      const next = new Date(d);
      patch(next);
      return next;
    });
  const daysInMonth = new Date(draft.getFullYear(), draft.getMonth() + 1, 0).getDate();
  const year = draft.getFullYear();
  const minYear = min !== undefined ? new Date(min).getFullYear() : year - 5;
  const hour = draft.getHours();
  return (
    <SheetModal onClosed={onClosed}>
      {(dismiss) => (
        <View style={[styles.sheet, { backgroundColor: c.dark ? '#1C1C1E' : '#F2F2F7' }]}>
          <View style={styles.sheetBar}>
            <Pressable onPress={() => dismiss()} accessibilityRole="button" hitSlop={8}>
              <T color={c.tabBar}>Cancel</T>
            </Pressable>
            <Pressable onPress={() => dismiss(() => onCommit(draft.getTime()))} accessibilityRole="button" hitSlop={8}>
              <T color={c.tabBar} weight="600">
                Done
              </T>
            </Pressable>
          </View>
          <View style={styles.wheels}>
            {mode === 'date' ? (
              <>
                <ListWheel label="Month" options={MONTHS} value={draft.getMonth()} onChange={(m) => set((d) => d.setMonth(m, Math.min(d.getDate(), new Date(d.getFullYear(), m + 1, 0).getDate())))} />
                <ListWheel label="Day" options={range(1, daysInMonth)} value={draft.getDate()} onChange={(v) => set((d) => d.setDate(v))} />
                <ListWheel label="Year" options={range(minYear, Math.max(minYear, year) + 5)} value={year} onChange={(y) => set((d) => d.setFullYear(y))} />
              </>
            ) : IS_12H ? (
              <>
                <ListWheel label="Hour" options={range(1, 12)} value={hour % 12 === 0 ? 12 : hour % 12} onChange={(h) => set((d) => d.setHours((h % 12) + (d.getHours() >= 12 ? 12 : 0)))} />
                <ListWheel label="Minute" options={range(0, 59, pad2)} value={draft.getMinutes()} onChange={(m) => set((d) => d.setMinutes(m))} />
                <ListWheel
                  label="AM or PM"
                  options={[
                    { value: 0, label: 'AM' },
                    { value: 1, label: 'PM' },
                  ]}
                  value={hour >= 12 ? 1 : 0}
                  onChange={(p) => set((d) => d.setHours((d.getHours() % 12) + p * 12))}
                />
              </>
            ) : (
              <>
                <ListWheel label="Hour" options={range(0, 23, pad2)} value={hour} onChange={(h) => set((d) => d.setHours(h))} />
                <ListWheel label="Minute" options={range(0, 59, pad2)} value={draft.getMinutes()} onChange={(m) => set((d) => d.setMinutes(m))} />
              </>
            )}
          </View>
        </View>
      )}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  row: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  band: { position: 'absolute', left: 8, right: 8, height: ROW, borderRadius: 8 },
  capsules: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  sheet: { borderRadius: 26, paddingBottom: 12, overflow: 'hidden' },
  sheetBar: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  wheels: { flexDirection: 'row', paddingHorizontal: 12 },
  capsule: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
});
