import * as Haptics from 'expo-haptics';
import { memo, useMemo, useRef, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Line, Text as SvgText } from 'react-native-svg';
import { HOUR, type ActiveOverride, type ActiveTempTarget, type CarbEntry, type GlucoseReading, type GlucoseUnit, type InsulinDose, type LoopRun, type Predictions, type TherapyProfile } from '@buddy/core';
import type { TrioColors } from '@/trio';
import { axisLabel, DEFAULT_VISIBLE_HOURS, glucoseDomain, glucoseTicks, hourTicks, MAX_VISIBLE_HOURS, MIN_VISIBLE_HOURS, paneHeights, ZOOM_PRESETS } from './chart-geometry';
import { BasalLayer, GlucosePane, GridLayer, type Frame } from './chart-layers';
import { CobIobPane } from './cob-iob-pane';
import { historyPoints, projectionPoints } from './cob-iob';
import { forecastLines } from './forecast';
import type { HomePrefs } from './prefs';

export interface MainChartProps {
  readonly c: TrioColors;
  readonly now: number;
  readonly height: number;
  readonly glucose: readonly GlucoseReading[];
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly CarbEntry[];
  readonly runs: readonly LoopRun[];
  readonly predictions?: Predictions;
  readonly predictionStart?: number;
  readonly profile: TherapyProfile;
  readonly units: GlucoseUnit;
  readonly prefs: HomePrefs;
  readonly override: ActiveOverride | null;
  readonly tempTarget: ActiveTempTarget | null;
  readonly onScrub?: (t: number | null) => void;
}

const Y_LABEL_W = 46;
const X_AXIS_H = 24;
const HISTORY_MS = 26 * HOUR;
const nextPreset = (v: number) => ZOOM_PRESETS.find((p) => p > v + 0.01) ?? ZOOM_PRESETS[0];

/**
 * MainChartView port: basal (10 %), glucose (66 %) and COB/IOB (24 %) panes on one time axis.
 * Drag pans, pinch zooms 1-24 h, double tap steps 6/12/24 h, press and hold scrubs a reading.
 */
export const MainChart = memo(function MainChart(p: MainChartProps) {
  const [w, setW] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [span, setSpan] = useState(DEFAULT_VISIBLE_HOURS);
  const [offset, setOffset] = useState(0);
  const start = useRef({ span: DEFAULT_VISIBLE_HOURS, offset: 0 });
  const { c, prefs } = p;
  const future = Math.min(3, span / 3) * HOUR;
  const t1 = p.now + future - offset;
  const t0 = t1 - span * HOUR;
  const plotW = Math.max(1, w - Y_LABEL_W);
  const panes = paneHeights(p.height, prefs.showCobIob);
  const bottom = p.height - X_AXIS_H;
  const msPerPx = (span * HOUR) / plotW;
  const clampOffset = (o: number) => Math.min(24 * HOUR, Math.max(0, o));

  const lastRun = p.runs.at(-1);
  const anchor = p.predictionStart ?? lastRun?.date ?? p.now;
  const history = useMemo(() => historyPoints(p.runs, p.now - HISTORY_MS, p.now), [p.runs, p.now]);
  const projectionEnd = Math.round((p.now + 3 * HOUR) / 300_000) * 300_000;
  const projection = useMemo(() => (prefs.showCobIob ? projectionPoints(p.doses, p.carbs, p.profile, history.at(-1)?.t ?? anchor, projectionEnd) : []), [prefs.showCobIob, p.doses, p.carbs, p.profile, history, anchor, projectionEnd]);
  const domain = useMemo(() => {
    const forecast = forecastLines(p.predictions, anchor, p.now).flatMap((l) => l.points.map((pt) => pt.v));
    return glucoseDomain(p.glucose.map((g) => g.value), forecast, prefs.low);
  }, [p.glucose, p.predictions, anchor, p.now, prefs.low]);

  const drag = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-10, 10])
    .failOffsetY([-14, 14])
    .onStart(() => {
      start.current = { span, offset };
    })
    .onUpdate((e) => setOffset(clampOffset(start.current.offset + e.translationX * msPerPx)));
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      start.current = { span, offset };
    })
    .onUpdate((e) => setSpan(Math.min(MAX_VISIBLE_HOURS, Math.max(MIN_VISIBLE_HOURS, start.current.span / e.scale))));
  const doubleTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(2)
    .onEnd(() => {
      void Haptics.selectionAsync();
      setSpan(nextPreset);
    });
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

  const f: Frame = { c, now: p.now, t0, t1, w, plotW, x: (t) => ((t - t0) / (t1 - t0)) * plotW };
  const mainTop = panes.basal;
  const mainPlotH = panes.main - (panes.cobIob === 0 ? X_AXIS_H : 0);
  const y = (v: number) => mainTop + (1 - (v - domain.min) / (domain.max - domain.min)) * mainPlotH;
  const hours = hourTicks(t0, t1, span);
  const grid = c.dark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
  const visible = p.glucose.filter((g) => g.date >= t0 && g.date <= t1);
  const cobIobTop = panes.basal + panes.main;

  return (
    <GestureDetector gesture={gesture}>
      <View onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={`Glucose chart, ${Math.round(span)} hours`}>
        <Svg width={w} height={p.height}>
          <BasalLayer f={f} height={panes.basal} doses={p.doses} profile={p.profile} />
          <GridLayer f={f} grid={grid} hourTicks={hours} yTicks={glucoseTicks(domain, p.units)} y={y} bottom={bottom} prefs={prefs} units={p.units} label={(v) => axisLabel(v, p.units)} />
          <GlucosePane f={f} y={y} domain={domain} prefs={prefs} profile={p.profile} glucose={visible} doses={p.doses} carbs={p.carbs} predictions={p.predictions} predictionStart={anchor} override={p.override} tempTarget={p.tempTarget} bottom={bottom} />
          {prefs.showCobIob ? <CobIobPane f={f} top={cobIobTop} height={panes.cobIob - X_AXIS_H} history={history} projection={projection} /> : null}
          {hours.map((t) => (
            <SvgText key={`h${t}`} x={f.x(t)} y={p.height - 6} fontSize={13} fill={c.primary} textAnchor="middle">
              {new Date(t).toLocaleTimeString([], { hour: 'numeric' })}
            </SvgText>
          ))}
          {cursor !== null && <Line x1={f.x(cursor)} x2={f.x(cursor)} y1={0} y2={bottom} stroke={c.primary} strokeWidth={1} />}
        </Svg>
      </View>
    </GestureDetector>
  );
});
