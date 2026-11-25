import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from './symbol';
import { useTrioColors } from './colors';
import { T } from './text';

/** SwiftUI `Picker(.segmented)` on iOS 26 (glass track, lifted selection). */
export function Segmented<V extends string>({ options, value, onChange }: { options: readonly { value: V; label: string }[]; value: V; onChange: (v: V) => void }) {
  const c = useTrioColors();
  if (Platform.OS === 'android') return <MaterialSegmented options={options} value={value} onChange={onChange} />;
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

/** Material 3 segmented buttons: outlined row, check mark and tonal fill on the selected segment. */
function MaterialSegmented<V extends string>({ options, value, onChange }: { options: readonly { value: V; label: string }[]; value: V; onChange: (v: V) => void }) {
  const c = useTrioColors();
  const outline = c.dark ? 'rgba(235,235,245,0.35)' : 'rgba(60,60,67,0.35)';
  return (
    <View style={[styles.mdTrack, { borderColor: outline }]} accessibilityRole="tablist">
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            android_ripple={{ color: `${c.tabBar}33` }}
            onPress={() => onChange(o.value)}
            style={[styles.mdItem, i > 0 && { borderLeftWidth: 1, borderLeftColor: outline }, selected && { backgroundColor: `${c.tabBar}38` }]}>
            {selected && options.length <= 3 ? <SymbolView name="checkmark" size={16} tintColor={c.primary} /> : null}
            <T style={{ fontSize: options.length > 3 ? 13 : 14, fontWeight: '600', letterSpacing: 0.1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  mdTrack: { flexDirection: 'row', height: 40, borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  mdItem: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  track: { flexDirection: 'row', padding: 3, borderRadius: 999, height: 36 },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
});
