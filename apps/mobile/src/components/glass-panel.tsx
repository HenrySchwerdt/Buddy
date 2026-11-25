import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { PropsWithChildren } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useEffect, useState } from 'react';
import { useTheme } from '@/theme/use-theme';
import { radius } from '@/theme/tokens';

interface Props {
  readonly style?: StyleProp<ViewStyle>;
  /** Semantic tint, e.g. the loop status colour. */
  readonly tint?: string;
  readonly padded?: boolean;
}

const liquid = Platform.OS === 'ios' && isLiquidGlassAvailable();

function useReduceTransparency() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceTransparencyEnabled?.().then(setReduce).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

/**
 * Surface used for every panel: real Liquid Glass on iOS 26, blur material below,
 * and an opaque fill when the user asked for reduced transparency (mirrors Trio's GlassChrome).
 */
export function GlassPanel({ children, style, tint, padded = true }: PropsWithChildren<Props>) {
  const theme = useTheme();
  const reduce = useReduceTransparency();
  const base = [styles.panel, padded && styles.padded, { borderColor: tint ? `${tint}55` : theme.stroke }, style];

  if (reduce) {
    return <View style={[...base, { backgroundColor: theme.dark ? '#13283D' : '#FFFFFF' }]}>{children}</View>;
  }
  if (liquid) {
    return (
      <GlassView style={base} glassEffectStyle="regular" tintColor={tint ? `${tint}22` : undefined}>
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[...base, styles.clip]}>
      <BlurView intensity={theme.dark ? 30 : 50} tint={theme.dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint ? `${tint}14` : theme.surface }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderCurve: 'continuous' },
  padded: { padding: 16 },
  clip: { overflow: 'hidden' },
});
