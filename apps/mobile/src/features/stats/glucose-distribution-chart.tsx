import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import type { GlucoseUnit } from '@buddy/core';
import { useTrioColors } from '@/trio';
import { pad2 } from './chart-kit';
import { DYN, alpha, glucoseValue, pctWhole } from './format';
import { Legend } from './ui';

const CHART_H = 200;
const AXIS_W = 44;
const X_LABEL_H = 24;

/** Band colours bottom → top (GlucoseDistributionChart). */
export const BAND_COLORS: Readonly<Record<string, string>> = {
  vlow: alpha(DYN.red, 0.8),
  low: alpha(DYN.orange, 0.8),
  tight: alpha(DYN.green, 0.8),
  inrange: alpha(DYN.teal, 0.8),
  high1: alpha(DYN.blue, 0.8),
  high2: alpha(DYN.indigo, 0.8),
  vhigh: alpha(DYN.purple, 0.8),
};

export function bandLegend(units: GlucoseUnit, bottom: number, top: number) {
  const f = (v: number) => glucoseValue(v, units);
  return [
    { label: `<${f(54)}`, color: BAND_COLORS.vlow! },
    { label: `${f(54)}-${f(bottom)}`, color: BAND_COLORS.low! },
    { label: `${f(bottom)}-${f(top)}`, color: BAND_COLORS.tight! },
    { label: `${f(top)}-${f(180)}`, color: BAND_COLORS.inrange! },
    { label: `${f(180)}-${f(200)}`, color: BAND_COLORS.high1! },
    { label: `${f(200)}-${f(220)}`, color: BAND_COLORS.high2! },
    { label: `>${f(220)}`, color: BAND_COLORS.vhigh! },
  ];
}

/** GlucoseDistributionChart: hourly ranges as a normalized stacked area. */
export function GlucoseDistributionChart({ ranges, units, bottom, top }: { ranges: readonly { key: string; values: readonly number[] }[]; units: GlucoseUnit; bottom: number; top: number }) {
  const c = useTrioColors();
  const [w, setW] = useState(0);
  const plotW = Math.max(1, w - AXIS_W);
  const plotH = CHART_H - X_LABEL_H;
  const x = (h: number) => (h / 23) * plotW;
  const y = (f: number) => plotH - f * plotH;
  const totals = Array.from({ length: 24 }, (_, h) => ranges.reduce((a, r) => a + (r.values[h] ?? 0), 0));
  const cum = Array.from({ length: 24 }, () => 0);
  const layers = ranges.map((r) => {
    const lower = [...cum];
    for (let h = 0; h < 24; h++) cum[h]! += totals[h]! > 0 ? (r.values[h] ?? 0) / totals[h]! : 0;
    const upper = [...cum];
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const d = `M${hours.map((h) => `${x(h)},${y(upper[h]!)}`).join('L')}L${[...hours].reverse().map((h) => `${x(h)},${y(lower[h]!)}`).join('L')}Z`;
    return { key: r.key, d };
  });
  const grid = c.dark ? 'rgba(235,235,245,0.25)' : 'rgba(60,60,67,0.25)';
  return (
    <View style={{ gap: 8 }}>
      <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={{ height: CHART_H }} accessible accessibilityLabel="Glucose distribution by time of day chart">
        {w > 0 ? (
          <Svg width={w} height={CHART_H}>
            {layers.map((l) => (
              <Path key={l.key} d={l.d} fill={BAND_COLORS[l.key]} />
            ))}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <Line key={`g${f}`} x1={0} x2={plotW} y1={y(f)} y2={y(f)} stroke={grid} strokeWidth={0.5} />
            ))}
            {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
              <Line key={`v${h}`} x1={x(h)} x2={x(h)} y1={0} y2={plotH + 6} stroke={grid} strokeWidth={0.5} />
            ))}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <SvgText key={`l${f}`} x={plotW + 8} y={y(f) + 4} fontSize={13} fill={c.secondary}>
                {pctWhole(f)}
              </SvgText>
            ))}
            {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
              <SvgText key={`x${h}`} x={x(h)} y={plotH + 20} fontSize={13} fill={c.secondary} textAnchor="middle">
                {pad2(h)}
              </SvgText>
            ))}
          </Svg>
        ) : null}
      </View>
      <Legend columns={4} items={bandLegend(units, bottom, top)} />
    </View>
  );
}
