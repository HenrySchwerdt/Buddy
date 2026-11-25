import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { TREND_ROTATION, type Trend } from '@buddy/core';
import { T, useTrioColors } from '@/trio';

/** PumpView: reservoir capsule + battery, or "Add pump". */
export function PumpView({ reservoir, battery, onPress, hasPump }: { reservoir: number | null; battery: number | null; onPress: () => void; hasPump: boolean }) {
  const c = useTrioColors();
  if (!hasPump) {
    return (
      <Pressable onPress={onPress} style={styles.addDevice} accessibilityRole="button">
        <SymbolView name="keyboard.onehanded.left" size={30} tintColor={c.secondary} />
        <T style_="caption" secondary>
          Add pump
        </T>
      </Pressable>
    );
  }
  const low = reservoir !== null && reservoir < 20;
  const color = low ? c.loopRed : c.insulin;
  return (
    <Pressable onPress={onPress} style={{ gap: 22, alignItems: 'flex-start' }} accessibilityRole="button" accessibilityLabel={`Reservoir ${reservoir ?? 'unknown'} units, battery ${battery ?? 'unknown'} percent`}>
      <View style={[styles.reservoir, { borderColor: `${color}66` }]}>
        <SymbolView name="cross.vial.fill" size={16} tintColor={color} />
        <T style_="callout" rounded weight="700" color={color}>
          {reservoir === null ? '–' : `${Math.round(reservoir)} U`}
        </T>
      </View>
      {battery !== null && (
        <View style={styles.battery}>
          <SymbolView name={battery > 75 ? 'battery.100' : battery > 50 ? 'battery.75' : battery > 25 ? 'battery.50' : 'battery.25'} size={22} tintColor={battery > 25 ? c.loopGreen : c.loopRed} />
          <T style_="callout" rounded weight="700">
            {Math.round(battery)} %
          </T>
        </View>
      )}
    </Pressable>
  );
}

/** CurrentGlucoseView "bobble": disc, angular-gradient ring, trend triangle, value and age. */
export function GlucoseBobble({ value, color, trend, ago, delta, stale, onPress, empty }: { value: string; color: string; trend: Trend; ago: string; delta: string; stale: boolean; onPress: () => void; empty: boolean }) {
  const c = useTrioColors();
  const rotation = useRef(new Animated.Value(TREND_ROTATION[trend])).current;
  useEffect(() => {
    Animated.timing(rotation, { toValue: TREND_ROTATION[trend], duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [trend, rotation]);
  if (empty) {
    return (
      <Pressable onPress={onPress} style={styles.addDevice} accessibilityRole="button">
        <SymbolView name="sensor.tag.radiowaves.forward.fill" size={32} tintColor={c.primary} />
        <T style_="caption" weight="600">
          Add CGM
        </T>
      </Pressable>
    );
  }
  const size = 130;
  const rotate = rotation.interpolate({ inputRange: [-180, 180], outputRange: ['-180deg', '180deg'] });
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Glucose ${value}, ${ago}, delta ${delta}`} style={{ width: size + 26, height: size + 26, alignItems: 'center', justifyContent: 'center' }}>
      {!stale && trend !== 'unknown' && (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}>
          <View style={[styles.triangle, { top: (size + 26) / 2 - 11 }]} />
        </Animated.View>
      )}
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id="bobble" x1="0.5" y1="0" x2="0.5" y2="1">
            <Stop offset="0" stopColor="#B857FF" />
            <Stop offset="0.25" stopColor="#9F6CFA" />
            <Stop offset="0.5" stopColor="#7C8BF3" />
            <Stop offset="0.75" stopColor="#57AAEC" />
            <Stop offset="1" stopColor="#43BBE9" />
          </LinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2 - 4} fill={c.chart} stroke={stale ? c.loopGray : 'url(#bobble)'} strokeWidth={6} />
      </Svg>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
        <T rounded weight="700" size={42} color={stale ? c.secondary : color === c.loopGreen ? c.primary : color} style={stale && { textDecorationLine: 'line-through' }}>
          {value}
        </T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: -2 }}>
          <T style_="callout" rounded weight="600" secondary={stale}>
            {ago}
          </T>
          {!stale && delta ? (
            <T style_="callout" rounded weight="600">
              {delta}
            </T>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** LoopView: two-arc ring (spins while looping), last-loop time, eventual glucose. */
export function LoopView({ minutesAgo, looping, closed, failed, eventual, onPress }: { minutesAgo: number | null; looping: boolean; closed: boolean; failed: boolean; eventual: string | null; onPress: () => void }) {
  const c = useTrioColors();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!looping) return;
    const a = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => {
      a.stop();
      spin.setValue(0);
    };
  }, [looping, spin]);
  const color = failed || minutesAgo === null || minutesAgo > 12 ? c.loopRed : minutesAgo > 6 ? c.loopYellow : c.loopGreen;
  const d = 44;
  const r = d / 2 - 2;
  const circ = 2 * Math.PI * r;
  const gap = 0.12 * circ;
  const half = circ / 2 - gap;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Loop ${closed ? 'closed' : 'open'}, ${minutesAgo ?? 'no'} minutes ago`} style={{ alignItems: 'center', gap: 20 }}>
      <Animated.View style={{ transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}>
        <Svg width={d} height={d}>
          <Circle cx={d / 2} cy={d / 2} r={r} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" strokeDasharray={closed ? `${half} ${gap}` : '3 6'} strokeDashoffset={-gap / 2} />
        </Svg>
      </Animated.View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SymbolView name="arrow.right.circle" size={22} tintColor={c.primary} weight="bold" />
        <T style_="callout" rounded weight="700">
          {eventual ?? '--'}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  addDevice: { alignItems: 'center', gap: 6, width: 100 },
  reservoir: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, borderWidth: 2 },
  battery: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4 },
  center: { alignItems: 'center', justifyContent: 'center' },
  triangle: { position: 'absolute', right: 0, width: 0, height: 0, borderTopWidth: 11, borderBottomWidth: 11, borderLeftWidth: 16, borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: '#43BBE9' },
});
