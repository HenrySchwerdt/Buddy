import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './text';

interface Props {
  readonly value: number;
  readonly display: string;
  readonly unit?: string;
  readonly step: number;
  readonly min: number;
  readonly max: number;
  readonly color: string;
  readonly onChange: (v: number) => void;
  readonly label: string;
}

/** Large value with round −/+ buttons; holds steady under thumbs. */
export function BigStepper({ value, display, unit, step, min, max, color, onChange, label }: Props) {
  const set = (v: number) => {
    const next = Math.min(max, Math.max(min, Math.round(v / step) * step));
    if (next === value) return;
    void Haptics.selectionAsync();
    onChange(next);
  };
  const btn = (sym: 'minus' | 'plus', d: number, disabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${sym === 'minus' ? 'Decrease' : 'Increase'} ${label}`}
      disabled={disabled}
      onPress={() => set(value + d)}
      onLongPress={() => set(value + d * 5)}
      style={({ pressed }) => [styles.btn, { backgroundColor: `${color}22`, opacity: disabled ? 0.3 : 1, transform: [{ scale: pressed ? 0.92 : 1 }] }]}>
      <SymbolView name={sym} size={20} tintColor={color} weight="bold" />
    </Pressable>
  );
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label} ${display} ${unit ?? ''}`} accessibilityRole="adjustable">
      {btn('minus', -step, value <= min)}
      <View style={{ flex: 1, alignItems: 'center' }}>
        <Text variant="hero" color={color} style={{ fontSize: 48 }}>
          {display}
        </Text>
        {unit ? (
          <Text variant="caption" tone="faint">
            {unit}
          </Text>
        ) : null}
      </View>
      {btn('plus', step, value >= max)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  btn: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
});
