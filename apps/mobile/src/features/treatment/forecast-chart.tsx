import { SymbolView, type SFSymbol } from 'expo-symbols';
import { memo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import { HOUR, MINUTE, type GlucoseReading, type Predictions } from '@buddy/core';
import { T, trioGlucoseColor, type TrioColors } from '@/trio';
import { forecastCone } from './forecast';
import { bolusChipFormatter, formatGlucoseValue, type GlucoseUnits } from './formatting';

const SYSTEM_BLUE = '#0A84FF';
const MGDL_PER_MMOLL = 18.0182;
const PLOT_H = 120;
/** Room above the top grid line so its y-axis label is not clipped. */
const TOP_INSET = 8;
/** Hour labels closer than this to the left edge are left-aligned so they are not clipped. */
const EDGE_LABEL_PX = 10;
const X_LABEL_H = 22;
const Y_LABEL_W = 36;
const LOW = 70;
const HIGH = 180;

export interface ForecastChartProps {
  readonly c: TrioColors;
  readonly now: number;
  readonly glucose: readonly GlucoseReading[];
  readonly predictions: Predictions | undefined;
  readonly units: GlucoseUnits;
  readonly carbs: number;
  readonly amount: number;
  readonly eventualBG: number | null;
}

/** Trio's ForecastChart: carbs / insulin / eventual glucose chips above a glucose + forecast cone chart. */
export const ForecastChart = memo(function ForecastChart(p: ForecastChartProps) {
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.chips}>
        <Chip c={p.c} icon="fork.knife" tint={p.c.orange} label={`${p.carbs} g`} />
        <Chip c={p.c} icon="syringe.fill" tint={SYSTEM_BLUE} label={`${bolusChipFormatter(p.amount)} U`} />
        <Chip c={p.c} icon="arrow.right.circle" tint={p.c.primary} label={p.eventualBG == null ? '---' : formatGlucoseValue(p.eventualBG, p.units)} unit={p.units} neutral />
      </View>
      <Plot {...p} />
    </View>
  );
});

function Chip({ c, icon, tint, label, unit, neutral }: { c: TrioColors; icon: SFSymbol; tint: string; label: string; unit?: string; neutral?: boolean }) {
  const bg = neutral ? (c.dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)') : `${tint}33`;
  return (
    <View style={[styles.chip, { backgroundColor: bg }]} accessible accessibilityLabel={unit ? `${label} ${unit}` : label}>
      <SymbolView name={icon} size={15} tintColor={tint} />
      <T style_="footnote" color={tint}>
        {label}
      </T>
      {unit ? (
        <T style_="footnote" secondary>
          {unit}
        </T>
      ) : null}
    </View>
  );
}

function Plot(p: ForecastChartProps) {
  const [w, setW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const height = TOP_INSET + PLOT_H + X_LABEL_H;
  if (w === 0) return <View style={{ height }} onLayout={onLayout} />;

  const { c } = p;
  const cone = forecastCone(p.predictions);
  const t0 = p.now - 4 * HOUR;
  const t1 = p.now + cone.count * 5 * MINUTE;
  const plotW = Math.max(1, w - Y_LABEL_W);
  const visible = p.glucose.filter((g) => g.date >= t0 && g.date <= t1);
  const maxMgdl = Math.max(300, ...visible.map((g) => g.value)) > 300 ? 400 : 300;
  const mmol = p.units === 'mmol/L';
  const yMax = mmol ? maxMgdl / MGDL_PER_MMOLL : maxMgdl;
  const conv = (mgdl: number) => (mmol ? mgdl / MGDL_PER_MMOLL : mgdl);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * plotW;
  const y = (v: number) => TOP_INSET + (1 - Math.min(yMax, Math.max(0, v)) / yMax) * PLOT_H;
  const yStep = mmol ? 5 : 100;
  const yTicks = Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, i) => i * yStep);
  const hourTicks: number[] = [];
  for (let t = Math.ceil(t0 / (2 * HOUR)) * 2 * HOUR; t <= t1; t += 2 * HOUR) hourTicks.push(t);
  const grid = c.dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)';

  // Cone between min and max forecast (Trio caps the band at 300 and widens a zero band to ±1).
  const pts = cone.min.map((lo, i) => {
    const hi = cone.max[i]!;
    const same = lo === hi;
    const t = Math.min(p.now + i * 5 * MINUTE, t1);
    return { x: x(t), lo: y(conv(same ? lo - 1 : Math.min(lo, 300))), hi: y(conv(same ? hi + 1 : Math.min(hi, 300))) };
  });
  const cone_ = pts.length > 1 ? `M${pts.map((q) => `${q.x.toFixed(1)},${q.hi.toFixed(1)}`).join(' L')} L${[...pts].reverse().map((q) => `${q.x.toFixed(1)},${q.lo.toFixed(1)}`).join(' L')} Z` : null;
  const latest = visible.at(-1);

  return (
    <View onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={`Glucose and forecast chart${latest ? `, latest ${formatGlucoseValue(latest.value, p.units)} ${p.units}` : ''}`}>
      <Svg width={w} height={height}>
        {yTicks.map((v) => (
          <G key={v}>
            <Line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke={grid} strokeWidth={0.5} strokeDasharray="2 3" />
            <Line x1={plotW} x2={plotW + 3} y1={y(v)} y2={y(v)} stroke={c.secondary} strokeWidth={3} />
            <SvgText x={plotW + 8} y={y(v) + 4} fontSize={11} fill={c.secondary}>
              {String(v)}
            </SvgText>
          </G>
        ))}
        {hourTicks.map((t) => (
          <G key={t}>
            <Line x1={x(t)} x2={x(t)} y1={TOP_INSET} y2={TOP_INSET + PLOT_H} stroke={grid} strokeWidth={0.5} strokeDasharray="2 3" />
            <SvgText x={x(t)} y={TOP_INSET + PLOT_H + 16} fontSize={11} fill={c.secondary} textAnchor={x(t) < EDGE_LABEL_PX ? 'start' : 'middle'}>
              {new Date(t).getHours()}
            </SvgText>
          </G>
        ))}
        {visible.map((g) => (
          <Circle key={`${g.source}${g.date}`} cx={x(g.date)} cy={y(conv(g.value))} r={2.2} fill={trioGlucoseColor(c, g.value, LOW, HIGH)} />
        ))}
        <Line x1={x(p.now)} x2={x(p.now)} y1={TOP_INSET} y2={TOP_INSET + PLOT_H} stroke={c.dark ? '#636366' : '#AEAEB2'} strokeWidth={2} strokeDasharray="3 3" />
        {cone_ ? <Path d={cone_} fill={SYSTEM_BLUE} fillOpacity={0.5} /> : null}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 10, borderCurve: 'continuous' },
});
