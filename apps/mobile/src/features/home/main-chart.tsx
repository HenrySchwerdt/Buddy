import * as Haptics from 'expo-haptics';
import { memo, useRef, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Circle, G, Line, Path, Polygon, Text as SvgText } from 'react-native-svg';
import { scheduleValueAt, toMmol, HOUR, MINUTE, type CarbEntry, type GlucoseReading, type GlucoseUnit, type InsulinDose, type Predictions, type TherapyProfile } from '@buddy/core';
import { trioGlucoseColor, type TrioColors } from '@/trio';

export interface MainChartProps {
  readonly c: TrioColors;
  readonly now: number;
  readonly height: number;
  /** Initial visible span in hours (Trio default 6). */
  readonly hoursBack: number;
  readonly glucose: readonly GlucoseReading[];
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly CarbEntry[];
  readonly predictions?: Predictions;
  readonly predictionStart?: number;
  readonly profile: TherapyProfile;
  readonly units: GlucoseUnit;
  readonly low: number;
  readonly high: number;
  readonly onScrub?: (t: number | null) => void;
}

const Y_LABEL_W = 46;
const X_AXIS_H = 30;
const BASAL_H = 44;
const PRED_KEYS = ['iob', 'zt', 'cob', 'uam', 'main'] as const;
type Temp = Extract<InsulinDose, { kind: 'tempBasal' }>;

/**
 * MainChartView port: edge-to-edge, dashed grid, low (red) / high (purple) dashed limits,
 * target line (green), basal band at the top, glucose dots, oref prediction lines,
 * bolus and carb markers. Horizontal drag scrubs.
 */
export const MainChart = memo(function MainChart(p: MainChartProps) {
  const [w, setW] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [span, setSpan] = useState(p.hoursBack);
  const [offset, setOffset] = useState(0);
  const start = useRef({ span: p.hoursBack, offset: 0 });
  const { c } = p;
  const future = Math.min(3, span / 3) * HOUR;
  const t1 = p.now + future - offset;
  const t0 = t1 - span * HOUR;
  const clampOffset = (o: number) => Math.min(24 * HOUR, Math.max(0, o));
  const plotW = Math.max(1, w - Y_LABEL_W);
  const top = BASAL_H;
  const bottom = p.height - X_AXIS_H;
  const visible = p.glucose.filter((g) => g.date >= t0);
  const yMax = Math.max(250, Math.ceil(Math.max(0, ...visible.map((g) => g.value), ...Object.values(p.predictions ?? {}).flat().filter((v): v is number => typeof v === 'number')) / 50) * 50);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * plotW;
  const y = (v: number) => top + (1 - (Math.min(yMax, Math.max(0, v)) - 0) / yMax) * (bottom - top);
  const fmt = (v: number) => (p.units === 'mg/dL' ? String(v) : toMmol(v).toFixed(1));

  const msPerPx = (span * HOUR) / Math.max(1, plotW);
  // Drag pans through time.
  const drag = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-10, 10])
    .failOffsetY([-14, 14])
    .onStart(() => {
      start.current = { span, offset };
    })
    .onUpdate((e) => setOffset(clampOffset(start.current.offset + e.translationX * msPerPx)));
  // Pinch zooms between 1 h and 24 h.
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      start.current = { span, offset };
    })
    .onUpdate((e) => setSpan(Math.min(24, Math.max(1, start.current.span / e.scale))));
  // Double tap steps through 6 / 12 / 24 h, keeping the right edge.
  const doubleTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(2)
    .onEnd(() => {
      void Haptics.selectionAsync();
      setSpan((v) => (v < 6 ? 6 : v < 12 ? 12 : v < 24 ? 24 : 6));
    });
  // Press and hold, then slide, to scrub a reading.
  const scrub = Gesture.Pan()
    .runOnJS(true)
    .activateAfterLongPress(250)
    .onStart(() => void Haptics.selectionAsync())
    .onUpdate((e) => {
      const t = Math.min(p.now, Math.max(t0, t0 + (e.x / plotW) * (t1 - t0)));
      setCursor(t);
      p.onScrub?.(t);
    })
    .onFinalize(() => {
      setCursor(null);
      p.onScrub?.(null);
    });
  const gesture = Gesture.Simultaneous(pinch, Gesture.Exclusive(scrub, drag, doubleTap));

  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  if (w === 0) return <View style={{ height: p.height }} onLayout={onLayout} />;

  const target = scheduleValueAt(p.profile.target, p.now, p.profile.utcOffsetMinutes);
  const targetMid = (target.low + target.high) / 2;
  const yTicks = Array.from({ length: Math.floor(yMax / 50) }, (_, i) => (i + 1) * 50);
  const hourTicks: number[] = [];
  const step = span > 12 ? 3 : span > 6 ? 2 : 1;
  for (let t = Math.ceil(t0 / (step * HOUR)) * step * HOUR; t <= t1; t += step * HOUR) hourTicks.push(t);

  // Basal band (drawn downward from the top like Trio's basal area).
  const scheduled = (at: number) => scheduleValueAt(p.profile.basal, at, p.profile.utcOffsetMinutes);
  const temps = p.doses.filter((d): d is Temp => d.kind === 'tempBasal' && d.date + d.durationMin * MINUTE >= t0 && d.date <= p.now).sort((a, b) => a.date - b.date);
  const maxRate = Math.max(0.1, ...temps.map((t) => t.rate), ...p.profile.basal.map((b) => b.value)) * 1.2;
  const by = (rate: number) => (rate / maxRate) * (BASAL_H - 10);
  const segs: { from: number; to: number; rate: number }[] = [];
  let cur = t0;
  temps.forEach((tb, i) => {
    const end = Math.min(tb.date + tb.durationMin * MINUTE, temps[i + 1]?.date ?? Infinity, p.now);
    if (tb.date > cur) segs.push({ from: cur, to: tb.date, rate: scheduled(cur) });
    if (end > Math.max(tb.date, t0)) segs.push({ from: Math.max(tb.date, t0), to: end, rate: tb.rate });
    cur = Math.max(cur, end);
  });
  if (cur < p.now) segs.push({ from: cur, to: p.now, rate: scheduled(cur) });
  const basalPath = `M${x(t0)},0 ${segs.map((s) => `L${x(s.from).toFixed(1)},${by(s.rate).toFixed(1)} L${x(s.to).toFixed(1)},${by(s.rate).toFixed(1)}`).join(' ')} L${x(p.now)},0 Z`;

  // Cone of Uncertainty: min/max envelope over all forecast curves (Trio's default display).
  const predStart = p.predictionStart ?? p.now;
  const curves = PRED_KEYS.map((k) => p.predictions?.[k]).filter((v): v is readonly number[] => !!v && v.length > 1);
  const coneLen = curves.reduce((m, cv) => Math.max(m, cv.length), 0);
  const cone = Array.from({ length: coneLen }, (_, i) => {
    const vals = curves.map((cv) => cv[Math.min(i, cv.length - 1)]!);
    return { t: predStart + i * 5 * MINUTE, lo: Math.min(...vals), hi: Math.max(...vals) };
  }).filter((pt) => pt.t <= t1);
  const conePath = cone.length > 1 ? `M${cone.map((pt) => `${x(pt.t).toFixed(1)},${y(pt.hi).toFixed(1)}`).join(' L')} L${[...cone].reverse().map((pt) => `${x(pt.t).toFixed(1)},${y(pt.lo).toFixed(1)}`).join(' L')} Z` : null;
  const nearest = (t: number) => visible.reduce<GlucoseReading | null>((b, g) => (!b || Math.abs(g.date - t) < Math.abs(b.date - t) ? g : b), null);
  const boluses = p.doses.filter((d): d is Extract<InsulinDose, { kind: 'bolus' | 'smb' }> => (d.kind === 'bolus' || d.kind === 'smb') && d.date >= t0);
  const grid = c.dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)';

  return (
    <GestureDetector gesture={gesture}>
      <View onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={`Glucose chart, last ${p.hoursBack} hours`}>
        <Svg width={w} height={p.height}>
          <Path d={basalPath} fill={c.insulin} fillOpacity={0.35} />
          {hourTicks.map((t) => (
            <G key={t}>
              <Line x1={x(t)} x2={x(t)} y1={0} y2={bottom} stroke={grid} strokeDasharray="2 4" />
              <SvgText x={x(t)} y={p.height - 8} fontSize={13} fill={c.primary} textAnchor="middle">
                {new Date(t).getHours()}
              </SvgText>
            </G>
          ))}
          {yTicks.map((v) => (
            <G key={v}>
              <Line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke={grid} strokeDasharray="2 4" />
              <SvgText x={plotW + 8} y={y(v) + 5} fontSize={13} fill={c.primary}>
                {fmt(v)}
              </SvgText>
            </G>
          ))}
          <Line x1={0} x2={plotW} y1={y(p.high)} y2={y(p.high)} stroke={c.purple} strokeWidth={1.5} strokeDasharray="6 6" />
          <Line x1={0} x2={plotW} y1={y(p.low)} y2={y(p.low)} stroke={c.loopRed} strokeWidth={1.5} strokeDasharray="6 6" />
          <Line x1={0} x2={w} y1={y(targetMid)} y2={y(targetMid)} stroke={c.loopGreen} strokeWidth={1.5} />
          <Line x1={x(p.now)} x2={x(p.now)} y1={0} y2={bottom} stroke={c.secondary} strokeWidth={2} strokeDasharray="3 3" />

          {conePath ? <Path d={conePath} fill={c.insulin} fillOpacity={0.45} /> : null}
          {visible.map((g) => (
            <Circle key={`${g.source}${g.date}`} cx={x(g.date)} cy={y(g.value)} r={4} fill={trioGlucoseColor(c, g.value, p.low, p.high)} />
          ))}
          {boluses.map((b) => {
            const bx = x(b.date);
            const gy = y(nearest(b.date)?.value ?? 120) - 12;
            const s = b.kind === 'smb' ? 4 : 7;
            return (
              <G key={b.id}>
                <Polygon points={`${bx - s},${gy - s * 1.6} ${bx + s},${gy - s * 1.6} ${bx},${gy}`} fill={c.insulin} />
                {b.kind === 'bolus' && (
                  <SvgText x={bx} y={gy - s * 1.6 - 4} fontSize={12} fontWeight="600" fill={c.primary} textAnchor="middle">
                    {b.units.toFixed(1)}
                  </SvgText>
                )}
              </G>
            );
          })}
          {p.carbs
            .filter((cb) => cb.date >= t0)
            .map((cb) => {
              const cx = x(cb.date);
              const cy = y(nearest(cb.date)?.value ?? 120) + 16;
              return (
                <G key={cb.id}>
                  <Circle cx={cx} cy={cy} r={Math.min(9, 4 + cb.grams / 15)} fill={c.carbs} />
                  <SvgText x={cx} y={cy + 22} fontSize={12} fontWeight="600" fill={c.primary} textAnchor="middle">
                    {Math.round(cb.grams)}
                  </SvgText>
                </G>
              );
            })}
          {cursor !== null && <Line x1={x(cursor)} x2={x(cursor)} y1={0} y2={bottom} stroke={c.primary} strokeWidth={1} />}
        </Svg>
      </View>
    </GestureDetector>
  );
});
