import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';
import type { GlucoseReading, GlucoseUnit } from '@buddy/core';
import { T } from '@/trio';
import { rangeDetail, sectorStats, type SectorRange } from './calc';
import { DYN, glucoseValue, pctUpToOne } from './format';
import { ChartPopover, Row } from './ui';

const SIZE = 100;
const OUTER = 46;
const OUTER_SELECTED = 50;
const INNER_RATIO = 0.618;
const LONG_PRESS_MS = 250;
const RANGE_COLOR: Record<SectorRange, string> = { high: DYN.purple, inRange: DYN.green, low: DYN.red };

function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${cx + r * Math.sin(a)},${cy - r * Math.cos(a)}`;
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    // Full ring: two half arcs each.
    const m = a0 + Math.PI;
    return `M${p(r1, a0)}A${r1},${r1} 0 1 1 ${p(r1, m)}A${r1},${r1} 0 1 1 ${p(r1, a0)}M${p(r0, a0)}A${r0},${r0} 0 1 0 ${p(r0, m)}A${r0},${r0} 0 1 0 ${p(r0, a0)}Z`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

function Metric({ title, value, color }: { title: string; value: string; color?: string }) {
  return (
    <View style={{ gap: 5 }}>
      <T style_="subheadline" secondary>
        {title}
      </T>
      <T color={color}>{value}</T>
    </View>
  );
}

/** GlucoseSectorChart (showChart: true): TIR/TITR/high/low, average, median and the TIR ring. */
export function GlucoseSectorChart({ readings, units, bottom, top, highLimit }: { readings: readonly GlucoseReading[]; units: GlucoseUnit; bottom: number; top: number; highLimit: number }) {
  const [selected, setSelected] = useState<SectorRange | null>(null);
  const s = useMemo(() => sectorStats(readings, bottom, top, highLimit), [readings, bottom, top, highLimit]);
  const f = (v: number) => glucoseValue(v, units);
  if (!s) return <T>No glucose readings found.</T>;
  const detail = selected ? rangeDetail(readings, selected, f, bottom, top, highLimit) : null;

  const order: SectorRange[] = ['high', 'inRange', 'low'];
  let start = 0;
  const sectors = order.map((r) => {
    const sweep = (s.counts[r] / s.total) * Math.PI * 2;
    const seg = { range: r, a0: start, a1: start + sweep };
    start += sweep;
    return seg;
  });
  const pickAngle = (px: number, py: number) => {
    const dx = px - SIZE / 2;
    const dy = py - SIZE / 2;
    const a = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
    setSelected(sectors.find((sec) => a >= sec.a0 && a < sec.a1 && sec.a1 > sec.a0)?.range ?? null);
  };
  const gesture = Gesture.Pan()
    .runOnJS(true)
    .activateAfterLongPress(LONG_PRESS_MS)
    .onStart((e) => pickAngle(e.x, e.y))
    .onUpdate((e) => pickAngle(e.x, e.y))
    .onFinalize(() => setSelected(null));

  return (
    <View>
      <Row style={{ gap: 20 }}>
        <View style={[styles.col, { marginLeft: 5 }]}>
          <Metric title={`${f(bottom)}-${f(highLimit)}`} value={pctUpToOne(s.inRange)} color={DYN.teal} />
          <Metric title={`${f(bottom)}-${f(top)}`} value={pctUpToOne(s.tight)} color={DYN.green} />
        </View>
        <View style={styles.col}>
          <Metric title={`> ${f(highLimit)}`} value={pctUpToOne(s.high)} color={DYN.purple} />
          <Metric title={`< ${f(bottom)}`} value={pctUpToOne(s.low)} color={DYN.red} />
        </View>
        <View style={styles.col}>
          <Metric title="Average" value={f(s.average)} />
          <Metric title="Median" value={f(s.median)} />
        </View>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <GestureDetector gesture={gesture}>
            <View style={{ width: SIZE, height: SIZE }} accessible accessibilityLabel="Time in range distribution chart">
              <Svg width={SIZE} height={SIZE}>
                {sectors
                  .filter((sec) => sec.a1 > sec.a0)
                  .map((sec) => {
                    const outer = selected === sec.range ? OUTER_SELECTED : OUTER;
                    return <Path key={sec.range} d={arc(SIZE / 2, SIZE / 2, OUTER * INNER_RATIO, outer, sec.a0, sec.a1)} fill={RANGE_COLOR[sec.range]} fillRule="evenodd" />;
                  })}
              </Svg>
            </View>
          </GestureDetector>
        </View>
      </Row>
      {detail ? (
        <ChartPopover color={RANGE_COLOR[detail.range]} style={styles.popover}>
          <T style_="subheadline" weight="700" color={RANGE_COLOR[detail.range]} style={{ marginBottom: 4 }}>
            {detail.title}
          </T>
          {detail.percentages.map((p) => (
            <Row key={p.label} style={{ gap: 8 }}>
              <T style_="footnote">{p.label}</T>
              <T style_="footnote" weight="700">
                {pctUpToOne(p.fraction)}
              </T>
            </Row>
          ))}
          <Row style={{ gap: 20, marginTop: 4 }}>
            {(
              [
                ['Average', f(detail.average)],
                ['Median', f(detail.median)],
                ['SD', f(detail.sd)],
              ] as const
            ).map(([label, v]) => (
              <View key={label} style={{ gap: 5 }}>
                <T style_="footnote">{label}</T>
                <T style_="footnote" weight="700">
                  {v}
                </T>
              </View>
            ))}
          </Row>
        </ChartPopover>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  col: { gap: 10 },
  popover: { position: 'absolute', bottom: SIZE + 8, alignSelf: 'center' },
});
