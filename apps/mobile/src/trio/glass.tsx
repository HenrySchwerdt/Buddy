import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { PropsWithChildren } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTrioColors } from './colors';

const liquid = Platform.OS === 'ios' && isLiquidGlassAvailable();

export const PANEL_RADIUS = 26;

interface Props {
  readonly style?: StyleProp<ViewStyle>;
  readonly tint?: string;
  readonly tintOpacity?: number;
  readonly radius?: number;
  readonly interactive?: boolean;
}

/** Port of Trio's GlassPanelBackground: Liquid Glass on iOS 26, material + tint below. */
export function GlassPanel({ children, style, tint, tintOpacity = 0.12, radius = PANEL_RADIUS, interactive }: PropsWithChildren<Props>) {
  const c = useTrioColors();
  const hex = (o: number) => Math.round(o * 255).toString(16).padStart(2, '0');
  const stroke = tint ? `${tint}${hex(0.35 * 0.6)}` : c.glassStroke;
  if (Platform.OS === 'android') {
    // Material 3 has no glass: a filled surface-container card, tinted (secondary-container style)
    // when the panel carries a meaning colour.
    const md = { borderRadius: Math.min(radius, 24), backgroundColor: tint ? `${tint}${hex(Math.min(0.24, tintOpacity * 1.6))}` : c.chart, overflow: 'hidden' as const };
    return <View style={[md, style]}>{children}</View>;
  }
  const shape = { borderRadius: radius, borderCurve: 'continuous' as const, borderWidth: 1, borderColor: stroke };
  if (liquid) {
    return (
      <GlassView style={[shape, style]} glassEffectStyle="regular" isInteractive={interactive} tintColor={tint ? `${tint}${hex(tintOpacity)}` : undefined}>
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[shape, { overflow: 'hidden' }, style]}>
      <BlurView intensity={40} tint={c.dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      {tint ? <View style={[StyleSheet.absoluteFill, { backgroundColor: `${tint}${hex(tintOpacity)}` }]} /> : null}
      {children}
    </View>
  );
}

/** `.glassMaterialFill(Capsule())` for small chips (rate capsule, chart info circle). */
export function GlassChip({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const c = useTrioColors();
  if (liquid) return <GlassView style={[{ borderRadius: 999 }, style]} glassEffectStyle="regular">{children}</GlassView>;
  if (Platform.OS === 'android') return <View style={[{ borderRadius: 999, backgroundColor: c.fill }, style]}>{children}</View>;
  return (
    <View style={[{ borderRadius: 999, overflow: 'hidden' }, style]}>
      <BlurView intensity={30} tint={c.dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      {children}
    </View>
  );
}
