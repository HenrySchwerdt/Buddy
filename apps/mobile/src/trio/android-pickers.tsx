import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useTrioColors } from './colors';
import { T } from './text';

/*
 * Android stand-ins for the SwiftUI wheel and compact date picker. The iOS screens render the
 * native SwiftUI controls (1:1 with Trio); these keep the same layout and behaviour on Android.
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

type Dialog = 'date' | 'time' | null;

/** Date and/or time capsules that open the Material date and time dialogs. */
export function DateTimeCapsules({ value, min, onChange, date = true, time = true }: { value: number; min?: number; onChange: (t: number) => void; date?: boolean; time?: boolean }) {
  const c = useTrioColors();
  const [open, setOpen] = useState<Dialog>(null);
  const current = new Date(value);
  const close = () => setOpen(null);
  const pick = (d: Date) => {
    close();
    onChange(Math.max(min ?? -Infinity, d.getTime()));
  };
  const capsule = (kind: Exclude<Dialog, null>, text: string) => (
    <Pressable key={kind} onPress={() => setOpen(kind)} accessibilityRole="button" accessibilityLabel={text} style={({ pressed }) => [styles.capsule, { backgroundColor: c.fill, opacity: pressed ? 0.7 : 1 }]}>
      <T>{text}</T>
    </Pressable>
  );
  return (
    <View style={styles.capsules}>
      {date ? capsule('date', current.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })) : null}
      {time ? capsule('time', current.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null}
      {open ? (
        <DateTimePicker
          value={current}
          mode={open}
          minimumDate={open === 'date' && min !== undefined ? new Date(min) : undefined}
          accentColor={c.tabBar}
          onValueChange={(_, d) => pick(d)}
          onDismiss={close}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  band: { position: 'absolute', left: 8, right: 8, height: ROW, borderRadius: 8 },
  capsules: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  capsule: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
});
