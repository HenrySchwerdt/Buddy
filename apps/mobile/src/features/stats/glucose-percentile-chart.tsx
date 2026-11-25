import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import type { GlucoseUnit } from '@buddy/core';
import { T, useTrioColors } from '@/trio';
import type { HourlyStats } from './calc';
import { niceTicks, pad2, runs } from './chart-kit';
import { DYN, SYS, alpha, glucoseValue, glucoseWithUnit, inUnits } from './format';
import { ChartPopover, Legend, Row } from './ui';

const CHART_H = 200;
const AXIS_W = 44;
const X_LABEL_H = 24;
const LONG_PRESS_MS = 250;

interface Props {
  readonly stats: readonly HourlyStats[];
  readonly units: GlucoseUnit;
  readonly bottom: number;
  readonly top: number;
  readonly highLimit: number;
  readonly isToday: boolean;
  readonly nowHour: number;
}

/** GlucosePercentileChart: AGP with 10–90 % / 25–75 % bands, median and 70/140/180 rules. */
export function GlucosePercentileChart({ stats, units, bottom, top, highLimit, isToday, nowHour }: Props) {
  const c = useTrioColors();
  const [w, setW] = useState(0);
  const [hour, setHour] = useState<number | null>(null);

  const valid = stats.filter((s) => s.median > 0);
  const yMin = inUnits(40, units);
  const yMax = Math.max(valid.length ? inUnits(Math.max(...valid.map((s) => s.p90)), units) : inUnits(400, units), inUnits(highLimit, units));
  const plotW = Math.max(1, w - AXIS_W);
  const plotH = CHART_H - X_LABEL_H;
  const x = (h: number) => (h / 23) * plotW;
  const y = (mgdl: number) => plotH - ((inUnits(mgdl, units) - yMin) / (yMax - yMin)) * plotH;
  const yv = (v: number) => plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const band = (lo: (s: HourlyStats) => number, hi: (s: HourlyStats) => number) =>
    runs(24, (i) => stats[i]!.median > 0)
      .map((r) => {
        const upper = r.map((i) => `${x(i)},${y(hi(stats[i]!))}`);
        const lower = [...r].reverse().map((i) => `${x(i)},${y(lo(stats[i]!))}`);
        return `M${upper.join('L')}L${lower.join('L')}Z`;
      })
      .join(' ');
  const median = runs(24, (i) => stats[i]!.median > 0)
    .map((r) => `M${r.map((i) => `${x(i)},${y(stats[i]!.median)}`).join('L')}`)
    .join(' ');

  const selected = hour !== null && !(isToday && hour > nowHour) ? stats.find((s) => s.hour === hour && s.median > 0) : undefined;
  const pick = (px: number) => setHour(Math.max(0, Math.min(23, Math.round((px / plotW) * 23))));
  const gesture = Gesture.Pan()
    .runOnJS(true)
    .activateAfterLongPress(LONG_PRESS_MS)
    .onStart((e) => pick(e.x))
    .onUpdate((e) => pick(e.x))
    .onFinalize(() => setHour(null));

  const rules = [
    { v: bottom, color: DYN.red },
    { v: top, color: DYN.green },
    { v: highLimit, color: DYN.purple },
  ];
  const grid = c.dark ? 'rgba(235,235,245,0.25)' : 'rgba(60,60,67,0.25)';

  return (
    <View style={{ gap: 8 }}>
      <T style_="headline">Ambulatory Glucose Profile (AGP)</T>
      <T style_="footnote" align="right">
        {units}
      </T>
      <GestureDetector gesture={gesture}>
        <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={{ height: CHART_H }} accessible accessibilityLabel="Glucose percentile chart">
          {w > 0 ? (
            <Svg width={w} height={CHART_H}>
              {niceTicks(yMin, yMax).map((t) => (
                <Line key={`g${t}`} x1={0} x2={plotW} y1={yv(t)} y2={yv(t)} stroke={grid} strokeWidth={0.5} />
              ))}
              {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
                <Line key={`v${h}`} x1={x(h)} x2={x(h)} y1={0} y2={plotH + 6} stroke={grid} strokeWidth={0.5} strokeDasharray="2,2" />
              ))}
              <Path d={band((s) => s.p10, (s) => s.p90)} fill={alpha(SYS.blue, 0.3)} />
              <Path d={band((s) => s.p25, (s) => s.p75)} fill={alpha(SYS.blue, 0.5)} />
              <Path d={median} stroke={SYS.blue} strokeWidth={2} fill="none" />
              {rules.map((r) => (
                <Line key={`r${r.v}`} x1={0} x2={plotW} y1={y(r.v)} y2={y(r.v)} stroke={r.color} strokeWidth={1} strokeDasharray="5,5" />
              ))}
              {selected ? <Line x1={x(selected.hour)} x2={x(selected.hour)} y1={0} y2={plotH} stroke={alpha(SYS.blue, 0.5)} strokeWidth={1} /> : null}
              {niceTicks(yMin, yMax).map((t) => (
                <SvgText key={`l${t}`} x={plotW + 8} y={yv(t) + 4} fontSize={13} fill={c.secondary}>
                  {units === 'mg/dL' ? t.toFixed(0) : t.toFixed(1)}
                </SvgText>
              ))}
              {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
                <SvgText key={`x${h}`} x={x(h)} y={plotH + 20} fontSize={13} fill={c.secondary} textAnchor="middle">
                  {pad2(h)}
                </SvgText>
              ))}
            </Svg>
          ) : null}
          {selected ? (
            <ChartPopover style={{ position: 'absolute', top: -8, left: Math.min(Math.max(0, x(selected.hour) - 90), Math.max(0, plotW - 180)), width: 180 }}>
              <T style_="subheadline" weight="700">
                {`${pad2(selected.hour)}:00 – ${pad2((selected.hour + 1) % 24)}:00`}
              </T>
              {(
                [
                  ['Median:', selected.median],
                  ['90%:', selected.p90],
                  ['75%:', selected.p75],
                  ['25%:', selected.p25],
                  ['10%:', selected.p10],
                ] as const
              ).map(([label, v]) => (
                <Row key={label} style={{ gap: 8 }}>
                  <T style_="headline" style={{ width: 66 }}>
                    {label}
                  </T>
                  <T style_="headline">{glucoseValue(v, units)}</T>
                  <T style_="headline" secondary>
                    {units}
                  </T>
                </Row>
              ))}
            </ChartPopover>
          ) : null}
        </View>
      </GestureDetector>
      <Legend
        columns={3}
        items={[
          { label: '10-90%', color: alpha(SYS.blue, 0.3) },
          { label: '25-75%', color: alpha(SYS.blue, 0.5) },
          { label: 'Median', color: SYS.blue },
          { label: glucoseWithUnit(bottom, units), color: DYN.red },
          { label: glucoseWithUnit(top, units), color: DYN.green },
          { label: glucoseWithUnit(highLimit, units), color: DYN.purple },
        ]}
      />
    </View>
  );
}
