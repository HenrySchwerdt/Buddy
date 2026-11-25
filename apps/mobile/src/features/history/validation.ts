import { toMgdl, type GlucoseUnit } from '@buddy/core';

/** Trio's manual glucose limits (HistoryRootView+AddGlucose): 14…720 mg/dL. */
export const MANUAL_GLUCOSE_MIN_MGDL = 14;
export const MANUAL_GLUCOSE_MAX_MGDL = 720;

/** Parses the entry field (comma or dot), in display units; null when not a number. */
export function parseGlucoseInput(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(v) ? v : null;
}

/** Display-unit value → integer mg/dL, or null when outside Trio's limits. */
export function manualGlucoseMgdl(value: number | null, units: GlucoseUnit): number | null {
  if (value === null) return null;
  const mgdl = Math.trunc(units === 'mmol/L' ? toMgdl(value) : value);
  return mgdl >= MANUAL_GLUCOSE_MIN_MGDL && mgdl <= MANUAL_GLUCOSE_MAX_MGDL ? mgdl : null;
}
