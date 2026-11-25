import { Host, Slider } from '@expo/ui';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { T, useTrioColors } from '@/trio';
import { DateTimeCapsules, ListWheel } from '@/trio/android-pickers';

/*
 * Android twin of native.tsx (Metro picks this file on Android). Same exports and props; the
 * SwiftUI controls are replaced by the shared Android wheel, Material dialogs and Compose slider.
 */

/** Slider drags report no "editing ended" on Android, so the end is the first pause this long. */
const SLIDER_SETTLE_MS = 400;

export interface WheelOption {
  readonly value: number;
  readonly label: string;
}

export function Wheel({ value, options, onChange, label }: { value: number; options: readonly WheelOption[]; onChange: (v: number) => void; label: string }) {
  return <ListWheel label={label} value={value} options={options} onChange={onChange} />;
}

export function WheelRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

export function CompactDateTime({ value, min, onChange }: { value: number; min: number; onChange: (t: number) => void }) {
  return <DateTimeCapsules value={value} min={min} onChange={onChange} />;
}

export function StepSlider({ value, min, max, step, minLabel, maxLabel, onChange, onEditingChanged }: { value: number; min: number; max: number; step: number; minLabel: string; maxLabel: string; onChange: (v: number) => void; onEditingChanged: (editing: boolean) => void }) {
  const c = useTrioColors();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingChanged = useRef(onEditingChanged);
  editingChanged.current = onEditingChanged;
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const change = (v: number) => {
    if (!timer.current) editingChanged.current(true);
    else clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      editingChanged.current(false);
    }, SLIDER_SETTLE_MS);
    onChange(v);
  };
  return (
    <View style={styles.slider}>
      <T style_="footnote" secondary>
        {minLabel}
      </T>
      <Host matchContents={{ vertical: true }} style={{ flex: 1 }} colorScheme={c.dark ? 'dark' : 'light'} seedColor={c.tabBar}>
        <Slider value={value} min={min} max={max} step={step} onValueChange={change} />
      </Host>
      <T style_="footnote" secondary>
        {maxLabel}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  slider: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
});
