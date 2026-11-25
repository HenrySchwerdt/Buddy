import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { DAY_SECONDS, type TherapyItem } from './logic';
import { OB } from './theme';

const HEIGHT = 180;
const AXIS_RIGHT = 34;
const AXIS_BOTTOM = 22;
const HOURS = [0, 6, 12, 18];

/** Nice tick step for ~`count` ticks (Swift Charts `.automatic(desiredCount:)`). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const span = Math.max(max - min, 1e-6);
  const raw = span / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw * 10);
  const first = Math.floor(min / step) * step;
  const last = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= last + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

interface Props {
  readonly items: readonly TherapyItem[];
  readonly color: string;
  /** Convert a stored value to the displayed axis value (mg/dL → mmol/L). */
  readonly display?: (v: number) => number;
  readonly fill?: boolean;
  readonly lineWidth?: number;
  readonly yDomain?: readonly [number, number];
  readonly label: string;
}

/** 24-hour step chart of a therapy schedule (Trio's `TherapyProfileChart`). */
export function TherapyChart({ items, color, display = (v) => v, fill = true, lineWidth = 1, yDomain, label }: Props) {
  const [width, setWidth] = useState(0);
  const values = items.map((i) => display(i.value));
  const ticks = yDomain ? niceTicks(yDomain[0], yDomain[1]) : niceTicks(0, Math.max(...values, 0.1));
  const lo = yDomain ? yDomain[0] : 0;
  const hi = yDomain ? yDomain[1] : ticks[ticks.length - 1]!;
  const plotW = Math.max(0, width - AXIS_RIGHT);
  const plotH = HEIGHT - AXIS_BOTTOM;
  const x = (sec: number) => (sec / DAY_SECONDS) * plotW;
  const y = (v: number) => plotH - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * plotH;
  const segments = items.map((item, i) => ({ x0: x(item.time), x1: x(items[i + 1]?.time ?? DAY_SECONDS), y: y(display(item.value)) }));
  const line = segments.map((s, i) => `${i === 0 ? 'M' : 'L'}${s.x0},${s.y} L${s.x1},${s.y}`).join(' ');
  const gid = `g-${color.replace(/[^a-z0-9]/gi, '')}`;
  const visibleTicks = ticks.filter((t) => t >= lo - 1e-6 && t <= hi + 1e-6);

  return (
    <View style={{ height: HEIGHT }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} accessible accessibilityLabel={label}>
      {width > 0 ? (
        <Svg width={width} height={HEIGHT}>
          <Defs>
            <LinearGradient id={gid} x1="0" y1="1" x2="0" y2="0">
              <Stop offset="0" stopColor={color} stopOpacity={0.6} />
              <Stop offset="1" stopColor={color} stopOpacity={0.1} />
            </LinearGradient>
          </Defs>
          {visibleTicks.map((t) => (
            <Line key={`y${t}`} x1={0} x2={plotW} y1={y(t)} y2={y(t)} stroke={OB.secondary} strokeOpacity={0.5} strokeWidth={1} strokeDasharray="2,4" />
          ))}
          {[...HOURS, 24].map((h) => (
            <Line key={`x${h}`} x1={x(h * 3600)} x2={x(h * 3600)} y1={0} y2={plotH} stroke={OB.secondary} strokeOpacity={0.5} strokeWidth={1} strokeDasharray="2,4" />
          ))}
          {fill ? segments.map((s, i) => <Rect key={i} x={s.x0} y={s.y} width={Math.max(0, s.x1 - s.x0)} height={Math.max(0, plotH - s.y)} fill={`url(#${gid})`} />) : null}
          <Path d={line} stroke={color} strokeWidth={lineWidth} fill="none" />
          {visibleTicks.map((t) => (
            <SvgText key={`l${t}`} x={plotW + 6} y={y(t) + 4} fontSize={11} fill={OB.secondary}>
              {String(t)}
            </SvgText>
          ))}
          {HOURS.map((h) => (
            <SvgText key={`h${h}`} x={x(h * 3600) + 4} y={HEIGHT - 4} fontSize={11} fill={OB.secondary}>
              {String(h).padStart(2, '0')}
            </SvgText>
          ))}
        </Svg>
      ) : null}
    </View>
  );
}
