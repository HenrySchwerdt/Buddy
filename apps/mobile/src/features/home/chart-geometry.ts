import { HOUR, MINUTE, scheduleValueAt, toMmol, type GlucoseUnit, type TherapyProfile } from '@buddy/core';

/** Pane shares of the chart stack (MainChartView.basalHeight / mainHeight / cobIobHeight). */
export const BASAL_SHARE = 0.1;
export const MAIN_SHARE = 0.66;
export const COB_IOB_SHARE = 0.24;
export const GLUCOSE_PAD = 25;
export const MIN_VISIBLE_HOURS = 1;
export const MAX_VISIBLE_HOURS = 24;
export const DEFAULT_VISIBLE_HOURS = 6;
/** Double tap cycles through these (Config.zoomPresets). */
export const ZOOM_PRESETS = [6, 12, 24] as const;

export interface PaneHeights {
  readonly basal: number;
  readonly main: number;
  readonly cobIob: number;
}

/** Without the COB/IOB pane the glucose pane takes its share. */
export function paneHeights(total: number, showCobIob: boolean): PaneHeights {
  return { basal: total * BASAL_SHARE, main: total * (showCobIob ? MAIN_SHARE : MAIN_SHARE + COB_IOB_SHARE), cobIob: showCobIob ? total * COB_IOB_SHARE : 0 };
}

export interface Domain {
  readonly min: number;
  readonly max: number;
}

/** updateGlucoseChartYAxis + paddedGlucoseYDomain (mg/dL). */
export function glucoseDomain(glucose: readonly number[], forecast: readonly number[], low: number): Domain {
  if (glucose.length === 0) return { min: 39 - GLUCOSE_PAD, max: 200 + GLUCOSE_PAD };
  const minG = Math.min(...glucose);
  const maxG = Math.max(...glucose);
  const maxF = forecast.length ? Math.min(Math.max(...forecast), maxG + 50) : maxG + 50;
  const minOverall = Math.min(minG, forecast.length ? Math.min(...forecast) : minG);
  const maxOverall = Math.max(maxG, maxF);
  const max = maxOverall > 325 ? 400 : maxOverall > 275 ? 350 : maxOverall > 225 ? 300 : maxOverall > 200 ? 250 : 200;
  return { min: Math.min(minOverall, low - 20) - GLUCOSE_PAD, max: max + GLUCOSE_PAD };
}

/** Axis ticks inside the domain: every 50 mg/dL, or every 2 mmol/L. */
export function glucoseTicks(d: Domain, units: GlucoseUnit): number[] {
  const step = units === 'mg/dL' ? 50 : 36;
  const out: number[] = [];
  for (let v = Math.ceil(d.min / step) * step; v <= d.max; v += step) if (v > 0) out.push(v);
  return out;
}

export const axisLabel = (mgdl: number, units: GlucoseUnit) => (units === 'mg/dL' ? String(Math.round(mgdl)) : toMmol(mgdl).toFixed(units === 'mmol/L' ? 0 : 1));

/** Whole-hour tick times; thins out as the window grows. */
export function hourTicks(t0: number, t1: number, spanHours: number): number[] {
  const step = spanHours > 12 ? 3 : spanHours > 6 ? 2 : 1;
  const out: number[] = [];
  const d = new Date(t0);
  d.setMinutes(0, 0, 0);
  for (let t = d.getTime(); t <= t1; t += HOUR) {
    if (t >= t0 && new Date(t).getHours() % step === 0) out.push(t);
  }
  return out;
}

export interface TargetSegment {
  readonly from: number;
  readonly to: number;
  readonly value: number;
}

/** Profile target as steps over the window (GlucoseTargetsView), sampled every 30 min and merged. */
export function targetSegments(profile: TherapyProfile, t0: number, t1: number): TargetSegment[] {
  const out: { from: number; to: number; value: number }[] = [];
  const step = 30 * MINUTE;
  for (let t = Math.floor(t0 / step) * step; t < t1; t += step) {
    const r = scheduleValueAt(profile.target, t + 1, profile.utcOffsetMinutes);
    const value = (r.low + r.high) / 2;
    const last = out.at(-1);
    if (last && last.value === value) last.to = t + step;
    else out.push({ from: t, to: t + step, value });
  }
  return out;
}

/** Bolus label shows from this amount (BolusDisplayThreshold). */
export const showBolusLabel = (units: number, threshold: number) => units >= threshold;

/** Marker sizes (MainChartHelper.Config). */
export const bolusSize = (units: number) => 5 + units * 1.8;
export const carbSize = (grams: number) => Math.min(5 + grams * 0.3, 30);
