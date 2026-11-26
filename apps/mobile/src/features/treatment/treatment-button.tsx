import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { T, useTrioColors } from '@/trio';

const SYSTEM_GRAY = '#8E8E93';

/**
 * Trio's treatment button: systemBlue, systemRed (disabled) when a limit is exceeded,
 * systemGray when disabled. `PrimaryButton` has no "disabled but red" state, hence this.
 */
export function TreatmentButton({ label, onPress, disabled, limitExceeded }: { label: string; onPress: () => void; disabled: boolean; limitExceeded: boolean }) {
  const c = useTrioColors();
  const bg = limitExceeded ? c.red : disabled ? SYSTEM_GRAY : c.accent;
  return (
    <Pressable
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: pressed ? 0.85 : 1 }]}>
      <T style_="headline" color={bg === c.accent ? c.onAccent : '#FFFFFF'} style={{ fontSize: 18 }} numberOfLines={1} adjustsFontSizeToFit>
        {label}
      </T>
    </Pressable>
  );
}

/** `CustomProgressView` over a blurred sheet while the treatment is processed. */
export function BusyOverlay({ text }: { text: string }) {
  const c = useTrioColors();
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal accessibilityLiveRegion="polite">
      <BlurView intensity={20} tint={c.dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      <View style={styles.center}>
        <View style={[styles.box, { backgroundColor: c.chart }]}>
          <ActivityIndicator color={c.primary} />
          <T style_="subheadline">{text}</T>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous', paddingHorizontal: 20 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  box: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderRadius: 16 },
});
