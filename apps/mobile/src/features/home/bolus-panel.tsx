import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { SymbolView } from '@/trio/symbol';
import { currentPump } from '@/runtime/runtime';
import { GlassPanel, T, useTrioColors } from '@/trio';
import { PANEL_H } from './layout';
import type { BolusProgress } from './bolus-progress';

const GRADIENT = ['#B857FF', '#9F6CFA', '#7C8BF3', '#57AAEC', '#43BBE9'];

/** Views/BolusProgressBar.swift: gradient bar growing with `progress`; a travelling segment while the amount is unknown. */
export function BolusProgressBar({ progress }: { progress: number | null }) {
  const slide = useRef(new Animated.Value(0)).current;
  const width = useRef(0);
  useEffect(() => {
    if (progress !== null) return;
    const a = Animated.loop(Animated.timing(slide, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [progress, slide]);
  const bar = (w: number) => (
    <Svg width={w} height={6}>
      <Defs>
        <LinearGradient id="bolusBar" x1="0" y1="0" x2="1" y2="0">
          {GRADIENT.map((c, i) => (
            <Stop key={c} offset={i / (GRADIENT.length - 1)} stopColor={c} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect width={w} height={6} rx={3} fill="url(#bolusBar)" />
    </Svg>
  );
  return (
    <View style={styles.barTrack} onLayout={(e) => (width.current = e.nativeEvent.layout.width)} pointerEvents="none">
      {progress !== null ? (
        <View style={{ width: `${progress * 100}%`, overflow: 'hidden', borderRadius: 3 }}>{bar(Math.max(1, width.current))}</View>
      ) : (
        <Animated.View style={{ width: '30%', overflow: 'hidden', borderRadius: 3, transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(1, width.current) * 0.7] }) }] }}>
          {bar(Math.max(60, width.current * 0.3))}
        </Animated.View>
      )}
    </View>
  );
}

async function cancelBolus() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  const r = await currentPump()?.cancelBolus();
  if (r && !r.ok) Alert.alert('Bolus Not Cancelled', r.error);
}

const fmt = (u: number) => String(Number(u.toFixed(3)));

/** HomeRootView+BottomControls `bolusView`: icon, "Bolusing" / "Initiating…", amount line, cancel button, progress bar. */
export function BolusPanel({ bolus }: { bolus: BolusProgress }) {
  const c = useTrioColors();
  const label = bolus.status === 'inProgress' ? 'Bolusing' : 'Initiating…';
  const detail = bolus.total !== null && bolus.delivered !== null ? `${fmt(bolus.delivered)} of ${fmt(bolus.total)} U` : bolus.total !== null ? `0 of ${fmt(bolus.total)} U` : 'Delivering insulin';
  return (
    <View accessibilityLiveRegion="polite">
      <GlassPanel tint={c.insulin} tintOpacity={0.18} style={styles.panel}>
        <View style={styles.row}>
          <SymbolView name="cross.vial.fill" size={25} tintColor={c.primary} />
          <View style={{ flex: 1, paddingLeft: 5 }} accessible accessibilityLabel={label} accessibilityValue={{ text: detail }}>
            <T style_="subheadline">{label}</T>
            <T style_="caption">{detail}</T>
          </View>
          {bolus.status === 'inProgress' ? (
            <Pressable onPress={() => void cancelBolus()} accessibilityRole="button" accessibilityLabel="Cancel bolus" hitSlop={8}>
              <SymbolView name="xmark.app" size={25} tintColor={c.primary} />
            </Pressable>
          ) : (
            <ActivityIndicator color={c.primary} />
          )}
        </View>
        <View style={styles.bar}>
          <BolusProgressBar progress={bolus.progress} />
        </View>
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { height: PANEL_H },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18 },
  bar: { position: 'absolute', left: 18, right: 18, bottom: 1 },
  barTrack: { height: 6 },
});
