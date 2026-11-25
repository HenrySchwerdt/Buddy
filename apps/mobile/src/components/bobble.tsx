import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { TREND_ROTATION, type Trend } from '@buddy/core';
import { useTheme } from '@/theme/use-theme';
import { Text } from './text';

interface Props {
  readonly value: string;
  readonly valueColor: string;
  readonly trend: Trend;
  readonly delta: string;
  readonly ago: string;
  readonly stale: boolean;
  readonly size?: number;
  readonly accessibilityLabel: string;
}

/**
 * Trio's glucose "bobble": a disc with a gradient ring and a triangle that rotates around
 * the ring to point in the trend direction.
 */
export function Bobble({ value, valueColor, trend, delta, ago, stale, size = 132, accessibilityLabel }: Props) {
  const theme = useTheme();
  const rotation = useRef(new Animated.Value(TREND_ROTATION[trend])).current;
  useEffect(() => {
    Animated.timing(rotation, { toValue: TREND_ROTATION[trend], duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [trend, rotation]);

  const r = size / 2 - 7;
  const showArrow = trend !== 'unknown' && !stale;
  const rotate = rotation.interpolate({ inputRange: [-180, 180], outputRange: ['-180deg', '180deg'] });

  return (
    <View style={{ width: size + 24, height: size + 24, alignItems: 'center', justifyContent: 'center' }} accessible accessibilityRole="summary" accessibilityLabel={accessibilityLabel}>
      {showArrow && (
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]} pointerEvents="none">
          <View style={[styles.pointer, { top: (size + 24) / 2 - 9, right: 0, borderLeftColor: '#43BBE9' }]} />
        </Animated.View>
      )}
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#B857FF" />
            <Stop offset="0.5" stopColor="#7C8BF3" />
            <Stop offset="1" stopColor="#43BBE9" />
          </LinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={r} fill={theme.dark ? '#16182A' : '#FFFFFF'} />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={stale ? theme.textFaint : 'url(#ring)'} strokeWidth={6} fill="none" />
      </Svg>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.content}>
          <Text variant="hero" color={stale ? theme.textFaint : valueColor} style={stale ? styles.strike : undefined} numberOfLines={1} adjustsFontSizeToFit>
            {value}
          </Text>
          <View style={styles.meta}>
            <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
              {delta}
            </Text>
          </View>
          <Text variant="caption" tone={stale ? 'danger' : 'faint'}>
            {ago}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pointer: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderTopWidth: 9,
    borderBottomWidth: 9,
    borderLeftWidth: 13,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  meta: { flexDirection: 'row', gap: 6, marginTop: -2 },
  strike: { textDecorationLine: 'line-through' },
});
