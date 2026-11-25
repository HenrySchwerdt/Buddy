import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/use-theme';
import { radius, space } from '@/theme/tokens';
import { Text } from './text';

interface Props<T> {
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (v: T) => void;
  readonly color?: string;
}

export function Chips<T>({ options, value, onChange, color }: Props<T>) {
  const theme = useTheme();
  const c = color ?? theme.accent;
  return (
    <View style={styles.wrap}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.label)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => {
              void Haptics.selectionAsync();
              onChange(o.value);
            }}
            style={({ pressed }) => [styles.chip, { backgroundColor: selected ? c : theme.surface, borderColor: selected ? c : theme.stroke, opacity: pressed ? 0.7 : 1 }]}>
            <Text variant="heading" style={{ fontSize: 14 }} color={selected ? '#fff' : theme.text}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
});
