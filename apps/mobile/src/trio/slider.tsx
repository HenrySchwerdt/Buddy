import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTrioColors } from './colors';

const THUMB = 28;
const TRACK = 4;

/** SwiftUI-style `Slider(value:in:step:)`: thin track, tinted fill, white round thumb. Drawn in JS (Android). */
export function JsSlider({ value, min, max, step, onChange, onEditingChanged, accessibilityLabel }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; onEditingChanged?: (editing: boolean) => void; accessibilityLabel?: string }) {
  const c = useTrioColors();
  const [width, setWidth] = useState(0);
  const live = useRef({ width: 0, min, max, step, onChange, onEditingChanged });
  live.current = { width, min, max, step, onChange, onEditingChanged };
  const last = useRef(value);
  const travel = Math.max(1, width - THUMB);
  const fraction = max === min ? 0 : (Math.min(max, Math.max(min, value)) - min) / (max - min);

  const valueAt = (x: number) => {
    const l = live.current;
    const f = Math.min(1, Math.max(0, (x - THUMB / 2) / Math.max(1, l.width - THUMB)));
    const stepped = Math.round((l.min + f * (l.max - l.min)) / l.step) * l.step;
    return Math.min(l.max, Math.max(l.min, Number(stepped.toFixed(6))));
  };
  const emit = (x: number) => {
    const v = valueAt(x);
    if (v !== last.current) {
      last.current = v;
      live.current.onChange(v);
    }
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        live.current.onEditingChanged?.(true);
        emit(e.nativeEvent.locationX);
      },
      onPanResponderMove: (e) => emit(e.nativeEvent.locationX),
      onPanResponderRelease: () => live.current.onEditingChanged?.(false),
      onPanResponderTerminate: () => live.current.onEditingChanged?.(false),
    }),
  ).current;
  last.current = value;

  return (
    <View
      style={styles.hit}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(Math.min(max, Math.max(min, value + (e.nativeEvent.actionName === 'increment' ? step : -step))))}
      {...pan.panHandlers}>
      <View pointerEvents="none" style={[styles.track, { backgroundColor: c.fill }]}>
        <View style={{ width: THUMB / 2 + fraction * travel, height: TRACK, backgroundColor: c.tabBar }} />
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left: fraction * travel }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { flex: 1, height: 44, justifyContent: 'center' },
  track: { height: TRACK, borderRadius: TRACK / 2, overflow: 'hidden' },
  thumb: { position: 'absolute', top: (44 - THUMB) / 2, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
});
