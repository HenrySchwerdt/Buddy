import * as Haptics from 'expo-haptics';
import { memo, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Polygon, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { scheduleValueAt, toMmol, HOUR, MINUTE, type CarbEntry, type GlucoseReading, type GlucoseUnit, type InsulinDose, type Predictions, type TherapyProfile } from '@buddy/core';
import { glucoseColor, fonts, type Theme } from '@/theme/tokens';

export interface ChartProps {
  readonly theme: Theme;
  readonly now: number;
  readonly hours: number;
  readonly height: number;
  readonly glucose: readonly GlucoseReading[];
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly CarbEntry[];
  readonly predictions?: Predictions;
  readonly predictionStart?: number;
  readonly profile: TherapyProfile;
  readonly units: GlucoseUnit;
  readonly lowLine: number;
  readonly highLine: number;
  /** Called with the scrubbed timestamp, or null when the finger lifts. */
  readonly onScrub?: (t: number | null) => void;
}

const BASAL_H = 30;
const AXIS_H = 20;
const PAD_R = 34;
const PAD_L = 8;
const PRED_KEYS = ['iob', 'zt', 'cob', 'uam', 'main'] as const;

type TempDose = Extract<InsulinDose, { kind: 'tempBasal' }>;

/**
 * Main chart in Trio's layout: basal pane on top, glucose with the four oref prediction
 * curves, bolus triangles above and carb dots below the readings, time axis at the bottom.
 * Drag horizontally to scrub; the parent shows the readout.
 */
export const GlucoseChart = memo(function GlucoseChart(p: ChartProps) {
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const theme = p.theme;
  const futureMs = Math.min(3, Math.max(1, p.hours / 3)) * HOUR;
  const t0 = p.now - p.hours * HOUR;
  const t1 = p.now + futureMs;
  const plotW = Math.max(1, width - PAD_R - PAD_L);
  const top = BASAL_H + 10;
  const bottom = p.height - AXIS_H;

  const yMax = useMemo(() => {
    const visible = p.glucose.filter((g) => g.date >= t0);
    return Math.min(400, Math.max(250, Math.ceil(Math.max(0, ...visible.map((g) => g.value)) / 50) * 50));
  }, [p.glucose, t0]);
  const x = (t: number) => PAD_L + ((t - t0) / (t1 - t0)) * plotW;
  const tAt = (px: number) => t0 + ((px - PAD_L) / plotW) * (t1 - t0);
  const y = (v: number) => top + (1 - (Math.min(yMax, Math.max(40, v)) - 40) / (yMax - 40)) * (bottom - top);
  const fmt = (mgdl: number) => (p.units === 'mg/dL' ? String(mgdl) : toMmol(mgdl).toFixed(1));

  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-6, 6])
    .failOffsetY([-14, 14])
    .onStart(() => void Haptics.selectionAsync())
    .onUpdate((e) => {
      const t = Math.min(p.now, Math.max(t0, tAt(e.x)));
      setCursor(t);
      p.onScrub?.(t);
    })
    .onFinalize(() => {
      setCursor(null);
      p.onScrub?.(null);
    });

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  if (width === 0) return <View style={{ height: p.height }} onLayout={onLayout} />;

  // Basal: scheduled line + temp area, drawn downward from the top like Trio.
  const scheduled = (at: number) => scheduleValueAt(p.profile.basal, at, p.profile.utcOffsetMinutes);
  const temps = p.doses.filter((d): d is TempDose => d.kind === 'tempBasal' && d.date + d.durationMin * MINUTE >= t0 && d.date <= p.now).sort((a, b) => a.date - b.date);
  const basalMax = Math.max(1, ...temps.map((t) => t.rate), ...p.profile.basal.map((b) => b.value)) * 1.15;
  const by = (rate: number) => 4 + (rate / basalMax) * (BASAL_H - 4);
  const segs: { from: number; to: number; rate: number; temp: boolean }[] = [];
  let cursorT = t0;
  temps.forEach((tb, i) => {
    const end = Math.min(tb.date + tb.durationMin * MINUTE, temps[i + 1]?.date ?? Infinity, p.now);
    if (tb.date > cursorT) segs.push({ from: cursorT, to: tb.date, rate: scheduled(cursorT), temp: false });
    if (end > Math.max(tb.date, t0)) segs.push({ from: Math.max(tb.date, t0), to: end, rate: tb.rate, temp: true });
    cursorT = Math.max(cursorT, end);
  });
  if (cursorT < p.now) segs.push({ from: cursorT, to: p.now, rate: scheduled(cursorT), temp: false });
  const basalArea = `M${x(t0)},4 ${segs.map((s) => `L${x(s.from).toFixed(1)},${by(s.rate).toFixed(1)} L${x(s.to).toFixed(1)},${by(s.rate).toFixed(1)}`).join(' ')} L${x(p.now)},4 Z`;
  const scheduledLine = Array.from({ length: 49 }, (_, i) => t0 + ((p.now - t0) * i) / 48)
    .map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${by(scheduled(t)).toFixed(1)}`)
    .join(' ');

  const stepH = p.hours > 12 ? 4 : p.hours > 6 ? 2 : 1;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / (stepH * HOUR)) * stepH * HOUR; t <= t1; t += stepH * HOUR) if (x(t) > PAD_L + 14 && x(t) < PAD_L + plotW - 14) ticks.push(t);

  const predStart = p.predictionStart ?? p.now;
  const predColor: Record<(typeof PRED_KEYS)[number], string> = { iob: theme.insulin, zt: theme.zt, cob: theme.cob, uam: theme.uam, main: theme.insulin };
  const preds = PRED_KEYS.flatMap((k) => {
    const series = p.predictions?.[k];
    if (!series || series.length < 2) return [];
    const d = series
      .map((v, i) => ({ t: predStart + i * 5 * MINUTE, v }))
      .filter((pt) => pt.t <= t1)
      .map((pt, i) => `${i ? 'L' : 'M'}${x(pt.t).toFixed(1)},${y(pt.v).toFixed(1)}`)
      .join(' ');
    return [{ k, d }];
  });

  const visible = p.glucose.filter((g) => g.date >= t0);
  const nearest = (t: number) => visible.reduce<GlucoseReading | null>((b, g) => (!b || Math.abs(g.date - t) < Math.abs(b.date - t) ? g : b), null);
  const boluses = p.doses.filter((d): d is Extract<InsulinDose, { kind: 'bolus' | 'smb' }> => (d.kind === 'bolus' || d.kind === 'smb') && d.date >= t0);
  const cursorG = cursor !== null ? nearest(cursor) : null;

  return (
    <GestureDetector gesture={pan}>
      <View onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={`Glucose chart, last ${p.hours} hours with predictions. Drag horizontally to inspect values.`}>
        <Svg width={width} height={p.height}>
          <Defs>
            <LinearGradient id="basal" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={theme.basal} stopOpacity={0.55} />
              <Stop offset="1" stopColor={theme.basal} stopOpacity={0.15} />
            </LinearGradient>
          </Defs>

          <Path d={basalArea} fill="url(#basal)" />
          <Path d={scheduledLine} stroke={theme.basal} strokeOpacity={0.6} strokeDasharray="3 3" strokeWidth={1} fill="none" />
          <Line x1={PAD_L} x2={PAD_L + plotW} y1={BASAL_H + 4} y2={BASAL_H + 4} stroke={theme.grid} />

          <Rect x={PAD_L} y={y(p.highLine)} width={plotW} height={Math.max(1, y(p.lowLine) - y(p.highLine))} fill={theme.targetBand} />
          {[p.lowLine, p.highLine].map((v) => (
            <G key={v}>
              <Line x1={PAD_L} x2={PAD_L + plotW} y1={y(v)} y2={y(v)} stroke={v === p.lowLine ? theme.low : theme.high} strokeOpacity={0.5} strokeDasharray="2 5" />
              <SvgText x={PAD_L + plotW + 6} y={y(v) + 4} fontSize={10} fill={theme.textFaint} fontFamily={fonts.bold}>
                {fmt(v)}
              </SvgText>
            </G>
          ))}
          <SvgText x={PAD_L + plotW + 6} y={y(yMax) + 9} fontSize={10} fill={theme.textFaint} fontFamily={fonts.bold}>
            {fmt(yMax)}
          </SvgText>

          {ticks.map((t) => (
            <G key={t}>
              <Line x1={x(t)} x2={x(t)} y1={top} y2={bottom} stroke={theme.grid} />
              <SvgText x={x(t)} y={p.height - 5} fontSize={10} fill={theme.textFaint} textAnchor="middle" fontFamily={fonts.bold}>
                {new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </SvgText>
            </G>
          ))}

          <Rect x={x(p.now)} y={top} width={Math.max(0, PAD_L + plotW - x(p.now))} height={bottom - top} fill={theme.dark ? 'rgba(255,255,255,0.025)' : 'rgba(10,34,55,0.03)'} />
          <Line x1={x(p.now)} x2={x(p.now)} y1={top - 4} y2={bottom} stroke={theme.textFaint} strokeDasharray="2 3" />

          {preds.map((pp) => (
            <Path key={pp.k} d={pp.d} stroke={predColor[pp.k]} strokeWidth={2.2} strokeOpacity={0.9} fill="none" strokeLinecap="round" strokeDasharray={pp.k === 'zt' ? '5 4' : undefined} />
          ))}

          {visible.map((g) => (
            <Circle key={`${g.source}${g.date}`} cx={x(g.date)} cy={y(g.value)} r={3.4} fill={glucoseColor(theme, g.value, p.lowLine, p.highLine)} />
          ))}

          {boluses.map((b) => {
            const bx = x(b.date);
            const gy = y(nearest(b.date)?.value ?? 120) - 10;
            const s = b.kind === 'smb' ? 3.5 : Math.min(8, 4.5 + b.units * 0.8);
            return (
              <G key={b.id}>
                <Polygon points={`${bx - s},${gy - s * 1.5} ${bx + s},${gy - s * 1.5} ${bx},${gy}`} fill={theme.insulin} />
                {b.kind === 'bolus' && (
                  <SvgText x={bx} y={gy - s * 1.5 - 3} fontSize={10} fill={theme.insulin} textAnchor="middle" fontFamily={fonts.extraBold}>
                    {b.units.toFixed(1)}
                  </SvgText>
                )}
              </G>
            );
          })}

          {p.carbs
            .filter((c) => c.date >= t0)
            .map((c) => {
              const cx = x(c.date);
              const cy = y(nearest(c.date)?.value ?? 120) + 14;
              return (
                <G key={c.id}>
                  <Circle cx={cx} cy={cy} r={Math.min(9, 4 + c.grams / 15)} fill={theme.cob} />
                  <SvgText x={cx} y={cy + 20} fontSize={10} fill={theme.cob} textAnchor="middle" fontFamily={fonts.extraBold}>
                    {Math.round(c.grams)}
                  </SvgText>
                </G>
              );
            })}

          {cursor !== null && (
            <G>
              <Line x1={x(cursor)} x2={x(cursor)} y1={4} y2={bottom} stroke={theme.text} strokeOpacity={0.5} strokeWidth={1} />
              {cursorG && <Circle cx={x(cursorG.date)} cy={y(cursorG.value)} r={6} fill={glucoseColor(theme, cursorG.value, p.lowLine, p.highLine)} stroke={theme.dark ? '#000' : '#fff'} strokeWidth={2} />}
            </G>
          )}
        </Svg>
      </View>
    </GestureDetector>
  );
});
