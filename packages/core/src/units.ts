export type GlucoseUnit = 'mg/dL' | 'mmol/L';

export const MGDL_PER_MMOLL = 18.0182;

export const toMmol = (mgdl: number): number => mgdl / MGDL_PER_MMOLL;
export const toMgdl = (mmol: number): number => mmol * MGDL_PER_MMOLL;

export function formatGlucose(mgdl: number, unit: GlucoseUnit): string {
  return unit === 'mg/dL' ? Math.round(mgdl).toString() : toMmol(mgdl).toFixed(1);
}

export function formatDelta(deltaMgdl: number, unit: GlucoseUnit): string {
  const sign = deltaMgdl >= 0 ? '+' : '−';
  const abs = Math.abs(deltaMgdl);
  return sign + (unit === 'mg/dL' ? Math.round(abs).toString() : toMmol(abs).toFixed(1));
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
