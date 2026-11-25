import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from '@/trio/symbol';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTrioColors } from './colors';
import { GlassPanel } from './glass';
import { T } from './text';

const DISMISS_LABELS = new Set(['Close', 'Cancel']);

/**
 * Toolbar capsule button (".glass" button style): "Close", "Presets +", "Add Override +".
 * Android: Material 3 text / icon button with a ripple instead of a glass capsule.
 */
export function CapsuleButton({ label, icon, iconFirst, onPress, color, accessibilityLabel }: { label?: string; icon?: SFSymbol; iconFirst?: boolean; onPress: () => void; color?: string; accessibilityLabel?: string }) {
  const c = useTrioColors();
  const tint = color ?? c.tabBar;
  if (Platform.OS === 'android' && label && DISMISS_LABELS.has(label)) {
    // Material dialogs and full-screen sheets dismiss with a close icon in the top app bar.
    return <CapsuleButton icon="xmark" onPress={onPress} accessibilityLabel={accessibilityLabel ?? label} />;
  }
  if (Platform.OS === 'android') {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        hitSlop={6}
        android_ripple={{ color: `${tint}40`, borderless: !label, radius: label ? undefined : 24 }}
        style={[styles.mdButton, !label && styles.mdIcon]}>
        {icon && !label ? <SymbolView name={icon} size={24} tintColor={c.primary} /> : null}
        {icon && label && iconFirst ? <SymbolView name={icon} size={18} tintColor={tint} /> : null}
        {label ? (
          <T color={tint} style={styles.mdLabel}>
            {label}
          </T>
        ) : null}
        {icon && label && !iconFirst ? <SymbolView name={icon} size={18} tintColor={tint} /> : null}
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} hitSlop={6} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <GlassPanel radius={999} interactive style={[styles.capsule, !label && styles.round]}>
        {icon && label && iconFirst ? <SymbolView name={icon} size={24} tintColor={tint} weight="medium" /> : null}
        {label ? (
          <T color={tint} style={{ fontSize: 17 }}>
            {label}
          </T>
        ) : null}
        {icon && !(label && iconFirst) ? <SymbolView name={icon} size={label ? 20 : 22} tintColor={label ? tint : c.primary} weight="medium" /> : null}
      </GlassPanel>
    </Pressable>
  );
}

/** Full-width primary action ("Continue Without Treatment", "Start Override"). */
export function PrimaryButton({ label, onPress, disabled, loading, color, style }: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean; color?: string; style?: StyleProp<ViewStyle> }) {
  const c = useTrioColors();
  const bg = disabled ? (Platform.OS === 'android' ? c.fill : c.dark ? '#3A3A3C' : '#D1D1D6') : (color ?? c.accent);
  return (
    <Pressable
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      android_ripple={{ color: 'rgba(255,255,255,0.25)' }}
      style={({ pressed }) => [styles.primary, Platform.OS === 'android' && styles.mdPrimary, { backgroundColor: bg, opacity: pressed && Platform.OS !== 'android' ? 0.85 : 1 }, style]}>
      {loading ? (
        <ActivityIndicator color={c.onAccent} />
      ) : (
        <T style_="headline" color={disabled ? c.secondary : color ? '#FFFFFF' : c.onAccent} style={{ fontSize: 18 }}>
          {label}
        </T>
      )}
    </Pressable>
  );
}

/** Text-only button in a row ("Open iOS Settings", "Suspend Insulin Delivery"). */
export function LinkButton({ label, onPress, color, destructive }: { label: string; onPress: () => void; color?: string; destructive?: boolean }) {
  const c = useTrioColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
      <T color={destructive ? c.red : (color ?? c.tabBar)}>{label}</T>
    </Pressable>
  );
}

/** Next/Back footer used by onboarding. */
export function NextButton({ label = 'Next', onPress, disabled }: { label?: string; onPress: () => void; disabled?: boolean }) {
  const c = useTrioColors();
  return (
    <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.next, { backgroundColor: disabled ? c.fill : c.accent, opacity: pressed ? 0.8 : 1 }]}>
      <T color={c.onAccent} style={{ fontSize: 19 }}>
        {label}
      </T>
      <SymbolView name="chevron.right" size={16} tintColor={c.onAccent} weight="semibold" />
    </Pressable>
  );
}

export function BackButton({ onPress, label = 'Back' }: { onPress: () => void; label?: string }) {
  const c = useTrioColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.back, { opacity: pressed ? 0.5 : 1 }]}>
      <SymbolView name="chevron.left" size={16} tintColor={c.primary} weight="semibold" />
      <T style={{ fontSize: 19 }}>{label}</T>
    </Pressable>
  );
}

export function Spacer() {
  return <View style={{ flex: 1 }} />;
}

const styles = StyleSheet.create({
  capsule: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, height: 44 },
  round: { width: 44, paddingHorizontal: 0, justifyContent: 'center' },
  // Material 3: text button 40 dp high, icon button 48 dp touch target, filled button 56 dp, full radius.
  mdButton: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 12, borderRadius: 20, overflow: 'hidden' },
  mdIcon: { width: 48, height: 48, paddingHorizontal: 0, justifyContent: 'center', borderRadius: 24 },
  mdLabel: { fontSize: 15, fontWeight: '600', letterSpacing: 0.1 },
  mdPrimary: { height: 56, borderRadius: 28, overflow: 'hidden' },
  primary: { height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  next: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, height: 52, borderRadius: 26 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, height: 52 },
});
