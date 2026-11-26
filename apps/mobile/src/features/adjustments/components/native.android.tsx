import { StyleSheet, View } from 'react-native';
import { T } from '@/trio';
import { JsSlider } from '@/trio/slider';
import { DateTimeCapsules, ListWheel } from '@/trio/android-pickers';

/*
 * Android twin of native.tsx (Metro picks this file on Android). Same exports and props; the
 * SwiftUI controls are replaced by the shared JS wheel, date sheet and slider.
 */

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
  return (
    <View style={styles.slider}>
      <T>{minLabel}</T>
      <JsSlider value={value} min={min} max={max} step={step} onChange={onChange} onEditingChanged={onEditingChanged} />
      <T>{maxLabel}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  slider: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
});
