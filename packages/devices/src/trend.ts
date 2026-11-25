import type { Trend } from '@buddy/core';

/** Nightscout / Dexcom direction strings → Buddy trend. */
export function trendFromDirection(direction: unknown): Trend {
  switch (String(direction)) {
    case 'DoubleUp': return 'doubleUp';
    case 'SingleUp': return 'singleUp';
    case 'FortyFiveUp': return 'fortyFiveUp';
    case 'Flat': return 'flat';
    case 'FortyFiveDown': return 'fortyFiveDown';
    case 'SingleDown': return 'singleDown';
    case 'DoubleDown': return 'doubleDown';
    default: return 'unknown';
  }
}

export const isPlausibleGlucose = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 39 && v <= 401;
