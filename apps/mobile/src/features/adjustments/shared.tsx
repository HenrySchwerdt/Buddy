import { Pressable, StyleSheet, View } from 'react-native';
import { T, useTrioColors } from '@/trio';

/** A preset tap waiting for (optional) confirmation (Trio `PendingPresetActivation`). */
export interface PresetActivation {
  readonly kind: 'override' | 'tempTarget';
  readonly id: string;
  readonly name: string;
  readonly run: () => void;
}

/** Empty `Section {} header: { Text(...).textCase(nil).foregroundStyle(.secondary) }`. */
export function EmptyHint({ text }: { text: string }) {
  return (
    <T secondary style={styles.empty}>
      {text}
    </T>
  );
}

/** Trio's sticky bottom bar with the red "Stop Override" / "Stop Temp Target" button. */
export function StickyStopBar({ label, onPress, bottom }: { label: string; onPress: () => void; bottom: number }) {
  const c = useTrioColors();
  return (
    <View style={[styles.sticky, { bottom, backgroundColor: c.dark ? 'rgba(3,15,28,0.8)' : 'rgba(255,255,255,0.8)' }]}>
      <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.stop, { backgroundColor: c.red, opacity: pressed ? 0.8 : 1 }]}>
        <T color="#FFFFFF">{label}</T>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { marginHorizontal: 20, marginTop: 8 },
  sticky: { position: 'absolute', left: 0, right: 0, height: 65, alignItems: 'center', justifyContent: 'center' },
  stop: { width: '90%', height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
