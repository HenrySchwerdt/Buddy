import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { useTrioColors } from '@/trio';

export interface ChartEntry {
  /** Minutes after midnight. */
  readonly minute: number;
  readonly value: number;
}

interface Props {
  /** Sorted by minute; each runs until the next one starts, the last until midnight. */
  readonly entries: readonly ChartEntry[];
  readonly color: string;
  readonly fillsArea?: boolean;
  readonly lineWidth?: number;
  readonly yDomain?: readonly [number, number];
  readonly formatY?: (v: number) => string;
  readonly accessibilityLabel: string;
}

const HEIGHT = 180;
const X_LABEL_SPACE = 22;
const TOP_SPACE = 8;
const Y_LABEL_SPACE = 40;
const DAY = 24 * 60;

/** "Nice" tick values (Swift Charts `.automatic(desiredCount: 4)`). */
function ticks(min: number, max: number, desired = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / desired;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= desired + 1) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/** Port of Trio's TherapyProfileChart: 24 h step chart with dashed grid. */
/** Baseline of the topmost y label, so a 12 pt label at the top grid line is not clipped. */
const LABEL_TOP = 12;

export function TherapyChart({ entries, color, fillsArea = true, lineWidth = 1, yDomain, formatY = String, accessibilityLabel }: Props) {
  const c = useTrioColors();
  const [width, setWidth] = useState(0);
  const values = entries.map((e) => e.value);
  const dataMax = Math.max(...values, 0);
  const lo = yDomain ? yDomain[0] : 0;
  const yTicks = ticks(lo, yDomain ? yDomain[1] : dataMax || 1);
  const hi = yDomain ? yDomain[1] : Math.max(dataMax, yTicks.at(-1) ?? 1);
  const plotW = Math.max(0, width - Y_LABEL_SPACE);
  const plotH = HEIGHT - X_LABEL_SPACE - TOP_SPACE;
  const x = (m: number) => (m / DAY) * plotW;
  const y = (v: number) => TOP_SPACE + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const segments = entries.map((e, i) => ({ x1: x(e.minute), x2: x(entries[i + 1]?.minute ?? DAY), y: y(e.value) }));
  const line = segments.map((s, i) => `${i === 0 ? 'M' : 'L'}${s.x1},${s.y} L${s.x2},${s.y}`).join(' ');
  const area = segments.length ? `${line} L${segments.at(-1)!.x2},${TOP_SPACE + plotH} L0,${TOP_SPACE + plotH} Z` : '';
  const grid = { stroke: c.secondary, strokeWidth: 1, strokeDasharray: '2,4', opacity: 0.6 };

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height: HEIGHT }} accessible accessibilityLabel={accessibilityLabel}>
      {width > 0 ? (
        <Svg width={width} height={HEIGHT}>
          <Defs>
            <LinearGradient id="fill" x1="0" y1="1" x2="0" y2="0">
              <Stop offset="0" stopColor={color} stopOpacity={0.6} />
              <Stop offset="1" stopColor={color} stopOpacity={0.1} />
            </LinearGradient>
          </Defs>
          {[0, 6, 12, 18, 24].map((h) => (
            <Line key={`x${h}`} x1={x(h * 60)} x2={x(h * 60)} y1={TOP_SPACE} y2={TOP_SPACE + plotH} {...grid} />
          ))}
          {yTicks.map((t) => (
            <Line key={`y${t}`} x1={0} x2={plotW} y1={y(t)} y2={y(t)} {...grid} />
          ))}
          {fillsArea && area ? <Path d={area} fill="url(#fill)" /> : null}
          {line ? <Path d={line} stroke={color} strokeWidth={lineWidth} fill="none" /> : null}
          {[0, 6, 12, 18].map((h) => (
            <SvgText key={`lx${h}`} x={x(h * 60) + 6} y={HEIGHT - 4} fill={c.secondary} fontSize={12}>
              {String(h).padStart(2, '0')}
            </SvgText>
          ))}
          {yTicks.map((t) => (
            <SvgText key={`ly${t}`} x={plotW + 6} y={Math.max(LABEL_TOP, y(t) + 4)} fill={c.secondary} fontSize={12}>
              {formatY(t)}
            </SvgText>
          ))}
            </Svg>
      ) : null}
    </View>
  );
}
