import { Fragment } from 'react';
import { Circle, G, Line, Path, Polygon, Text as SvgText } from 'react-native-svg';
import { MINUTE, scheduleValueAt, type ActiveOverride, type ActiveTempTarget, type CarbEntry, type GlucoseReading, type InsulinDose, type Predictions, type TherapyProfile } from '@buddy/core';
import type { TrioColors } from '@/trio';
import { MANUAL_SOURCE } from '@/features/history/rows';
import { bolusSize, carbSize, showBolusLabel, targetSegments, type Domain } from './chart-geometry';
import { forecastCone, forecastLines } from './forecast';
import { glucoseColor } from './glucose-color';
import type { HomePrefs } from './prefs';

export interface Frame {
  readonly c: TrioColors;
  readonly now: number;
  readonly t0: number;
  readonly t1: number;
  /** Full svg width and the part left of the pinned y-axis labels. */
  readonly w: number;
  readonly plotW: number;
  readonly x: (t: number) => number;
}

/** Trio's "DarkerBlue" asset, the IOB colour of the COB/IOB pane. */
export const DARKER_BLUE = '#1E49FF';
const THIRTY_DAYS = 30 * 24 * 60 * MINUTE;
type Temp = Extract<InsulinDose, { kind: 'tempBasal' }>;
type Bolus = Extract<InsulinDose, { kind: 'bolus' | 'smb' }>;

/** Basal pane: bars hang from the top, scheduled rate where no temp basal ran (BasalChart). */
export function BasalLayer({ f, height, doses, profile }: { f: Frame; height: number; doses: readonly InsulinDose[]; profile: TherapyProfile }) {
  const scheduled = (at: number) => scheduleValueAt(profile.basal, at, profile.utcOffsetMinutes);
  const temps = doses.filter((d): d is Temp => d.kind === 'tempBasal' && d.date + d.durationMin * MINUTE >= f.t0 && d.date <= f.now).sort((a, b) => a.date - b.date);
  const maxRate = Math.max(0.1, ...temps.map((t) => t.rate), ...profile.basal.map((b) => b.value));
  const by = (rate: number) => (rate / maxRate) * Math.max(0, height - 2);
  const segs: { from: number; to: number; rate: number }[] = [];
  let cur = f.t0;
  temps.forEach((tb, i) => {
    const end = Math.min(tb.date + tb.durationMin * MINUTE, temps[i + 1]?.date ?? Infinity, f.now);
    if (tb.date > cur) segs.push({ from: cur, to: tb.date, rate: scheduled(cur) });
    if (end > Math.max(tb.date, f.t0)) segs.push({ from: Math.max(tb.date, f.t0), to: end, rate: tb.rate });
    cur = Math.max(cur, end);
  });
  if (cur < f.now) segs.push({ from: cur, to: f.now, rate: scheduled(cur) });
  const d = `M${f.x(f.t0)},0 ${segs.map((s) => `L${f.x(s.from).toFixed(1)},${by(s.rate).toFixed(1)} L${f.x(s.to).toFixed(1)},${by(s.rate).toFixed(1)}`).join(' ')} L${f.x(f.now)},0 Z`;
  return <Path d={d} fill={f.c.insulin} fillOpacity={0.35} />;
}

/** Dashed grid: vertical hour lines over the whole stack, horizontal lines per y tick. */
export function GridLayer({ f, grid, hourTicks, yTicks, y, bottom, prefs, units, label }: { f: Frame; grid: string; hourTicks: readonly number[]; yTicks: readonly number[]; y: (v: number) => number; bottom: number; prefs: HomePrefs; units: string; label: (v: number) => string }) {
  return (
    <>
      {prefs.xGrid ? hourTicks.map((t) => <Line key={`x${t}`} x1={f.x(t)} x2={f.x(t)} y1={0} y2={bottom} stroke={grid} strokeWidth={0.5} strokeDasharray="2 3" />) : null}
      {yTicks.map((v) => (
        <G key={`y${v}`}>
          {prefs.yGrid ? <Line x1={0} x2={f.plotW} y1={y(v)} y2={y(v)} stroke={grid} strokeWidth={0.5} strokeDasharray="2 3" /> : null}
          <SvgText x={f.plotW + 8} y={y(v) + 5} fontSize={13} fill={f.c.primary} accessibilityLabel={`${label(v)} ${units}`}>
            {label(v)}
          </SvgText>
        </G>
      ))}
    </>
  );
}

export interface GlucosePaneProps {
  readonly f: Frame;
  readonly y: (mgdl: number) => number;
  readonly domain: Domain;
  readonly prefs: HomePrefs;
  readonly profile: TherapyProfile;
  readonly glucose: readonly GlucoseReading[];
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly CarbEntry[];
  readonly predictions?: Predictions;
  readonly predictionStart?: number;
  readonly override: ActiveOverride | null;
  readonly tempTarget: ActiveTempTarget | null;
  readonly bottom: number;
}

const FORECAST_COLOR = (c: TrioColors, k: string) => (k === 'uam' ? c.uam : k === 'zt' ? c.zt : k === 'cob' ? c.orange : c.insulin);

function pathOf(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** Glucose pane: thresholds, target, adjustment bands, markers, forecast and readings (MainChartCanvas.mainChart). */
export function GlucosePane(p: GlucosePaneProps) {
  const { f, y } = p;
  const c = f.c;
  const nearest = (t: number) => p.glucose.reduce<GlucoseReading | null>((b, g) => (!b || Math.abs(g.date - t) < Math.abs(b.date - t) ? g : b), null);
  const target = scheduleValueAt(p.profile.target, f.now, p.profile.utcOffsetMinutes);
  const targetMid = (target.low + target.high) / 2;
  const colorOpts = { scheme: p.prefs.scheme, low: p.prefs.low, high: p.prefs.high, target: targetMid };
  const predStart = p.predictionStart ?? f.now;
  const lines = p.prefs.forecastType === 'lines' ? forecastLines(p.predictions, predStart, f.now) : [];
  const cone = p.prefs.forecastType === 'cone' ? forecastCone(p.predictions, predStart, f.now) : [];
  const conePath = cone.length > 1 ? `${pathOf(cone.map((pt) => ({ x: f.x(pt.t), y: y(pt.hi) })))} ${[...cone].reverse().map((pt) => `L${f.x(pt.t).toFixed(1)},${y(pt.lo).toFixed(1)}`).join(' ')} Z` : null;
  const boluses = p.doses.filter((d): d is Bolus => (d.kind === 'bolus' || d.kind === 'smb') && d.units > 0 && d.date >= f.t0 && d.date <= f.t1);
  const band = (from: number, to: number, mgdl: number, color: string, opacity: number, key: string) => (
    <Line key={key} x1={Math.max(0, f.x(from))} x2={Math.min(f.plotW, f.x(to))} y1={y(mgdl)} y2={y(mgdl)} stroke={color} strokeOpacity={opacity} strokeWidth={8} />
  );
  return (
    <G>
      {p.prefs.thresholdLines ? (
        <>
          <Line x1={0} x2={f.plotW} y1={y(p.prefs.high)} y2={y(p.prefs.high)} stroke={c.purple} strokeWidth={1.5} strokeDasharray="6 6" />
          <Line x1={0} x2={f.plotW} y1={y(p.prefs.low)} y2={y(p.prefs.low)} stroke={c.loopRed} strokeWidth={1.5} strokeDasharray="6 6" />
        </>
      ) : null}
      {targetSegments(p.profile, f.t0, f.t1).map((s) => (
        <Line key={s.from} x1={Math.max(0, f.x(s.from))} x2={Math.min(f.w, f.x(s.to))} y1={y(s.value)} y2={y(s.value)} stroke={c.loopGreen} strokeWidth={1} />
      ))}
      <Line x1={f.x(f.now)} x2={f.x(f.now)} y1={0} y2={p.bottom} stroke={c.secondary} strokeWidth={2} strokeDasharray="3 3" />
      {p.override ? band(p.override.startedAt, p.override.durationMin === null ? p.override.startedAt + THIRTY_DAYS : p.override.startedAt + p.override.durationMin * MINUTE, p.override.target || targetMid, c.purple, 0.4, 'override') : null}
      {p.tempTarget ? band(p.tempTarget.startedAt, p.tempTarget.startedAt + p.tempTarget.durationMin * MINUTE, p.tempTarget.target, c.loopGreen, 0.4, 'tempTarget') : null}
      {boluses.map((b) => {
        const bx = f.x(b.date);
        const gy = y((nearest(b.date)?.value ?? targetMid) + 20);
        const s = bolusSize(b.units);
        return (
          <G key={b.id}>
            <Polygon points={`${bx - s * 0.5},${gy - s * 0.8} ${bx + s * 0.5},${gy - s * 0.8} ${bx},${gy}`} fill={c.insulin} />
            {showBolusLabel(b.units, p.prefs.bolusThreshold) ? (
              <SvgText x={bx} y={gy - s * 0.8 - 4} fontSize={11} fill={c.primary} textAnchor="middle">
                {Number(b.units.toFixed(2))}
              </SvgText>
            ) : null}
          </G>
        );
      })}
      {p.carbs
        .filter((cb) => cb.date >= f.t0 && cb.date <= f.t1)
        .map((cb) => {
          const cx = f.x(cb.date);
          const gy = y((nearest(cb.date)?.value ?? targetMid) - 20);
          const s = carbSize(cb.grams);
          return (
            <G key={cb.id}>
              <Polygon points={`${cx - s * 0.5},${gy + s * 0.8} ${cx + s * 0.5},${gy + s * 0.8} ${cx},${gy}`} fill={c.orange} />
              <SvgText x={cx} y={gy + s * 0.8 + 12} fontSize={11} fill={c.primary} textAnchor="middle">
                {Math.round(cb.grams)}
              </SvgText>
            </G>
          );
        })}
      {conePath ? <Path d={conePath} fill="#0A84FF" fillOpacity={0.5} /> : null}
      {lines.map((l) => (
        <Path key={l.key} d={pathOf(l.points.map((pt) => ({ x: f.x(pt.t), y: y(pt.v) })))} stroke={FORECAST_COLOR(c, l.key)} strokeWidth={1.5} fill="none" />
      ))}
      {p.glucose.map((g) => (
        <Fragment key={`${g.source}${g.date}`}>
          {g.source === MANUAL_SOURCE ? (
            <Path d={`M${f.x(g.date)},${y(g.value) - 5} q4,5 4,7.5 a4,4 0 1 1 -8,0 q0,-2.5 4,-7.5 Z`} fill="#FF3B30" />
          ) : (
            <Circle cx={f.x(g.date)} cy={y(g.value)} r={3} fill={glucoseColor(g.value, colorOpts)} />
          )}
        </Fragment>
      ))}
    </G>
  );
}
