export const MGDL_PER_MMOLL = 18.0182;
export const toMmol = (mgdl) => mgdl / MGDL_PER_MMOLL;
export const toMgdl = (mmol) => mmol * MGDL_PER_MMOLL;
export function formatGlucose(mgdl, unit) {
    return unit === 'mg/dL' ? Math.round(mgdl).toString() : toMmol(mgdl).toFixed(1);
}
export function formatDelta(deltaMgdl, unit) {
    const sign = deltaMgdl >= 0 ? '+' : '−';
    const abs = Math.abs(deltaMgdl);
    return sign + (unit === 'mg/dL' ? Math.round(abs).toString() : toMmol(abs).toFixed(1));
}
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
