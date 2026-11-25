import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/use-theme';
import { radius } from '@/theme/tokens';
import { Text } from './text';

interface Props<T extends string> {
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (v: T) => void;
}

/** iOS-style segmented control on a glass track. */
export function Segmented<T extends string>({ options, value, onChange }: Props<T>) {
  const theme = useTheme();
  return (
    <View style={[styles.track, { backgroundColor: theme.surface, borderColor: theme.stroke }]} accessibilityRole="tablist">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              onChange(o.value);
            }}
            style={[styles.item, selected && { backgroundColor: theme.dark ? 'rgba(255,255,255,0.16)' : '#FFFFFF', shadowOpacity: theme.dark ? 0 : 0.08 }]}>
            <Text variant="heading" style={{ fontSize: 14 }} tone={selected ? 'default' : 'muted'}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', padding: 3, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  item: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.pill, shadowColor: '#000', shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
});
