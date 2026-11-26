import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTrioColors } from './colors';
import { T } from './text';

/** SwiftUI `Picker(.segmented)` on iOS 26 (glass track, lifted selection); drawn in JS on both platforms. */
export function Segmented<V extends string>({ options, value, onChange }: { options: readonly { value: V; label: string }[]; value: V; onChange: (v: V) => void }) {
  const c = useTrioColors();
  return (
    <View style={[styles.track, { backgroundColor: c.dark ? 'rgba(118,118,128,0.24)' : 'rgba(118,118,128,0.12)' }]} accessibilityRole="tablist">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) void Haptics.selectionAsync();
              onChange(o.value);
            }}
            style={[styles.item, selected && { backgroundColor: c.dark ? 'rgba(255,255,255,0.28)' : '#FFFFFF' }]}>
            <T style={{ fontSize: 15, fontWeight: selected ? '600' : '500' }} numberOfLines={1}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', padding: 3, borderRadius: 999, height: 36 },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
});
