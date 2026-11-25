import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
import { useTrioColors } from '@/trio';
import type { IntervalWithToday, LoopStatsData } from './calc';
import { SYS, fixed, pctUpToOne, pctWhole } from './format';
import { Row, StatCard, StatView, Unavailable } from './ui';

export type LoopingChartType = 'performance' | 'cgmTrace' | 'upTime';
export const LOOPING_CHART_TYPES = [
  { value: 'performance', label: 'Looping Performance' },
  { value: 'cgmTrace', label: 'CGM Connection Trace' },
  { value: 'upTime', label: 'Trio Up-Time' },
] as const satisfies readonly { value: LoopingChartType; label: string }[];

const CHART_H = 200;
const BAR_H = 52;
const X_LABEL_H = 20;
const MIN_ANNOTATION_W = 130;

function annotation(kind: 'loops' | 'glucose', count: number, interval: IntervalWithToday): string {
  const perDay = interval !== 'day' && interval !== 'today';
  if (kind === 'loops') return `${count} ${perDay ? 'Loops per Day' : 'Loops'}`;
  return `${count} ${perDay ? 'Readings per Day' : 'Readings'}`;
}

/** LoopBarChartView: two horizontal bars (Successful Loops, Glucose Count) on a 0–100 % axis. */
function LoopBarChart({ data, interval }: { data: LoopStatsData; interval: IntervalWithToday }) {
  const c = useTrioColors();
  const [w, setW] = useState(0);
  const plotH = CHART_H - X_LABEL_H;
  const x = (pct: number) => (Math.min(100, Math.max(0, pct)) / 100) * w;
  const grid = c.dark ? 'rgba(235,235,245,0.3)' : 'rgba(60,60,67,0.3)';
  const rows = [
    { label: 'Successful Loops', pct: data.loopPercentage, text: annotation('loops', data.loops, interval), color: SYS.blue },
    { label: 'Glucose Count', pct: data.glucosePercentage, text: annotation('glucose', data.glucose, interval), color: SYS.green },
  ];
  const rowH = plotH / rows.length;
  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={{ height: CHART_H, margin: 16 }} accessible accessibilityLabel="Looping performance bar chart">
      {w > 0 ? (
        <Svg width={w} height={CHART_H}>
          {[0, 25, 50, 75, 100].map((p) => (
            <Line key={p} x1={x(p)} x2={x(p)} y1={0} y2={plotH} stroke={grid} strokeWidth={0.5} strokeDasharray="2,2" />
          ))}
          {interval !== 'today'
            ? [0, 25, 50, 75, 100].map((p) => (
                <SvgText key={`l${p}`} x={x(p)} y={CHART_H - 4} fontSize={13} fill={c.secondary} textAnchor={p === 0 ? 'start' : p === 100 ? 'end' : 'middle'}>
                  {pctWhole(p / 100)}
                </SvgText>
              ))
            : null}
          {rows.map((r, i) => {
            const top = i * rowH + 24;
            const width = x(r.pct);
            return [
              <SvgText key={`t${r.label}`} x={4} y={top - 8} fontSize={13} fill={c.secondary}>
                {r.label}
              </SvgText>,
              <Rect key={`b${r.label}`} x={0} y={top} width={Math.max(1, width)} height={BAR_H} rx={5} fill={r.color} />,
              // Swift Charts hides an overlay annotation that does not fit inside its bar.
              width >= MIN_ANNOTATION_W ? (
                <SvgText key={`a${r.label}`} x={width / 2} y={top + BAR_H / 2 + 6} fontSize={16} fill="#FFFFFF" textAnchor="middle">
                  {r.text}
                </SvgText>
              ) : null,
            ];
          })}
        </Svg>
      ) : null}
    </View>
  );
}

/** LoopStatsView. */
function LoopStatsRow({ data }: { data: LoopStatsData }) {
  const items = [
    ['Loops', String(data.loops)],
    ['Interval', `${fixed(data.medianInterval / 60, 1)}m`],
    ['Duration', `${fixed(data.medianDuration, 1)}s`],
    ['Success', pctUpToOne(data.loopPercentage / 100)],
    ['Days', String(data.totalDays)],
  ] as const;
  return (
    <Row style={{ justifyContent: 'space-between', padding: 16 }}>
      {items.map(([title, value]) => (
        <StatView key={title} title={title} value={value} />
      ))}
    </Row>
  );
}

export function LoopingStats({ type, data, interval }: { type: LoopingChartType; data: LoopStatsData | null; interval: IntervalWithToday }) {
  if (type !== 'performance') {
    return (
      <StatCard>
        <Unavailable title="Coming soon." icon="hourglass" description={LOOPING_CHART_TYPES.find((t) => t.value === type)?.label} />
      </StatCard>
    );
  }
  if (!data) {
    return (
      <StatCard>
        <Unavailable title="No Loop Data" icon="clock.arrow.2.circlepath" description="Loop statistics will appear here once data is available." />
      </StatCard>
    );
  }
  // Trio applies StatCard to a two-view builder, which yields two separate cards.
  return (
    <>
      <StatCard>
        <LoopBarChart data={data} interval={interval} />
      </StatCard>
      <StatCard>
        <LoopStatsRow data={data} />
      </StatCard>
    </>
  );
}

