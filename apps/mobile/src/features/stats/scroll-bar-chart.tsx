import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View, type ScrollViewInstance, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
import { useTrioColors } from '@/trio';
import { addDays, initialScrollPosition, startOfDay, visibleDateRange, visibleDomainMs, type Bucket, type Interval } from './calc';
import { niceTicks, pad2 } from './chart-kit';
import { alpha, fixed, pctWhole } from './format';

const AXIS_W = 36;
const X_LABEL_H = 22;
const HOUR_MS = 3_600_000;
const POPOVER_W = 170;

export interface ScrollBarChartProps {
  readonly buckets: readonly Bucket[];
  readonly interval: Interval;
  readonly now: number;
  /** One colour per value index (stacked bottom → top). */
  readonly colors: readonly string[];
  readonly height?: number;
  /** Values are fractions of 1 (100 % stacked). */
  readonly normalized?: boolean;
  /** Custom bar renderer (box plots); receives x, width and a y scale. */
  readonly renderBar?: (b: Bucket, x: number, width: number, y: (v: number) => number, dim: boolean) => ReactNode;
  /** Fixed y domain; defaults to 0…max of stacked values. */
  readonly yDomain?: readonly [number, number];
  readonly yLabel?: (v: number) => string;
  readonly onRangeChange?: (range: { start: number; end: number }) => void;
  readonly popover?: (b: Bucket) => ReactNode;
  readonly accessibilityLabel: string;
}

function weekdayShort(t: number) {
  return new Date(t).toLocaleDateString([], { weekday: 'short' });
}

/** Axis label per StatChartUtils.dateAxisMarks. */
function axisLabel(t: number, interval: Interval): string | null {
  const d = new Date(t);
  switch (interval) {
    case 'day':
      return d.getHours() % 6 === 0 ? pad2(d.getHours()) : null;
    case 'week':
      return weekdayShort(t);
    case 'month':
      return d.getDay() === 1 ? String(d.getDate()) : null;
    case 'total':
      return d.getDate() === 1 ? d.toLocaleDateString([], { month: 'short' }) : null;
  }
}

/** Horizontally scrollable bar chart (Swift Charts `.chartScrollableAxes(.horizontal)` look-alike). */
export function ScrollBarChart(p: ScrollBarChartProps) {
  const c = useTrioColors();
  const { buckets, interval, now, colors, height = 250, normalized } = p;
  const [w, setW] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const [selected, setSelected] = useState<Bucket | null>(null);
  const scroller = useRef<ScrollViewInstance>(null);

  const plotW = Math.max(1, w - AXIS_W);
  const plotH = height - X_LABEL_H;
  const unitMs = interval === 'day' ? HOUR_MS : 24 * HOUR_MS;
  const spanStart = buckets[0]?.date ?? startOfDay(now);
  const spanEnd = addDays(startOfDay(now), 1);
  const pxPerMs = plotW / visibleDomainMs(interval);
  const contentW = Math.max(plotW, (spanEnd - spanStart) * pxPerMs);
  const xOf = (t: number) => (t - spanStart) * pxPerMs;

  const [y0, y1] = useMemo(() => {
    if (p.yDomain) return p.yDomain;
    if (normalized) return [0, 1] as const;
    const max = Math.max(0, ...buckets.map((b) => b.values.reduce((a, v) => a + v, 0)));
    return [0, max > 0 ? max * 1.05 : 1] as const;
  }, [buckets, normalized, p.yDomain]);
  const y = (v: number) => plotH - ((v - y0) / (y1 - y0)) * plotH;
  const ticks = normalized ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(y0, y1);

  const report = (x: number) => {
    const pos = spanStart + x / pxPerMs;
    p.onRangeChange?.(visibleDateRange(pos, interval));
  };

  // Jump to the initial position whenever the interval or width changes.
  useEffect(() => {
    if (w === 0) return;
    const x = Math.max(0, Math.min(contentW - plotW, xOf(initialScrollPosition(interval, now))));
    setScrollX(x);
    scroller.current?.scrollTo({ x, animated: false });
    report(x);
    setSelected(null);
  }, [interval, w, buckets.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = e.nativeEvent.contentOffset.x;
    setScrollX(x);
    report(x);
  };

  const barW = unitMs * pxPerMs;
  const inset = Math.min(2, barW * 0.15);
  const grid = c.dark ? 'rgba(235,235,245,0.25)' : 'rgba(60,60,67,0.25)';
  const pick = (locationX: number) => {
    const t = spanStart + locationX / pxPerMs;
    setSelected(buckets.find((b) => t >= b.date && t < b.date + unitMs) ?? null);
  };

  const popLeft = selected ? Math.min(Math.max(0, xOf(selected.date) + barW / 2 - scrollX - POPOVER_W / 2), Math.max(0, plotW - POPOVER_W)) : 0;

  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={{ height }} accessible accessibilityLabel={p.accessibilityLabel}>
      {w > 0 ? (
        <>
          <View style={{ position: 'absolute', right: 0, top: 0, width: AXIS_W, height }}>
            <Svg width={AXIS_W} height={height}>
              {ticks.map((t) => (
                <SvgText key={t} x={6} y={y(t) + 4} fontSize={13} fill={c.secondary}>
                  {p.yLabel ? p.yLabel(t) : normalized ? pctWhole(t) : fixed(t, 0)}
                </SvgText>
              ))}
            </Svg>
          </View>
          <ScrollView
            ref={scroller}
            horizontal
            style={{ width: plotW }}
            showsHorizontalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={32}
            snapToInterval={barW > 0 ? barW : undefined}
            decelerationRate="fast">
            <Pressable onLongPress={(e) => pick(e.nativeEvent.locationX)} onPressOut={() => setSelected(null)} delayLongPress={250}>
              <Svg width={contentW} height={height}>
                {ticks.map((t) => (
                  <Line key={`g${t}`} x1={0} x2={contentW} y1={y(t)} y2={y(t)} stroke={grid} strokeWidth={0.5} />
                ))}
                {buckets.map((b) => {
                  const label = axisLabel(b.date, interval);
                  if (label === null || b.date >= spanEnd) return null;
                  const x = xOf(b.date) + barW / 2;
                  return (
                    <SvgText key={`x${b.date}`} x={x} y={plotH + 17} fontSize={13} fill={c.secondary} textAnchor="middle">
                      {label}
                    </SvgText>
                  );
                })}
                {buckets.map((b) => {
                  const label = axisLabel(b.date, interval);
                  if (label === null) return null;
                  return <Line key={`v${b.date}`} x1={xOf(b.date)} x2={xOf(b.date)} y1={0} y2={plotH} stroke={grid} strokeWidth={0.5} />;
                })}
                {buckets.map((b) => {
                  const x = xOf(b.date) + inset;
                  const bw = Math.max(1, barW - 2 * inset);
                  const dim = selected !== null && selected.date !== b.date;
                  if (p.renderBar) return <Fragment key={b.date}>{p.renderBar(b, x, bw, y, dim)}</Fragment>;
                  let acc = 0;
                  return b.values.map((v, i) => {
                    if (v <= 0) return null;
                    const top = y(acc + v);
                    const bottom = y(acc);
                    acc += v;
                    return <Rect key={`${b.date}-${i}`} x={x} y={top} width={bw} height={Math.max(0, bottom - top)} fill={dim ? alpha(colors[i] ?? '#888888', 0.3) : colors[i]} />;
                  });
                })}
                {selected ? (
                  <Line x1={xOf(selected.date) + barW / 2} x2={xOf(selected.date) + barW / 2} y1={0} y2={plotH} stroke={alpha(colors[0] ?? '#888888', 0.5)} strokeWidth={1} />
                ) : null}
              </Svg>
            </Pressable>
          </ScrollView>
          {selected && p.popover ? <View style={{ position: 'absolute', top: 0, left: popLeft, width: POPOVER_W }}>{p.popover(selected)}</View> : null}
        </>
      ) : null}
    </View>
  );
}
