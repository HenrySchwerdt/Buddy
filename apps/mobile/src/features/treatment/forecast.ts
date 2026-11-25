import type { Predictions } from '@buddy/core';

/** Trio draws at least 12 forecast points (1 h). */
export const MIN_FORECAST_COUNT = 12;
const KEYS = ['iob', 'zt', 'cob', 'uam', 'main'] as const;

export interface ForecastCone {
  readonly min: readonly number[];
  readonly max: readonly number[];
  /** Trio's `minCount`: number of 5-minute steps drawn. */
  readonly count: number;
}

/**
 * `Treatments.StateModel.updateForecasts`: per 5-minute index the min and max over all
 * non-empty prediction lines; length = max(12, shortest line).
 */
export function forecastCone(p: Predictions | undefined | null): ForecastCone {
  const lines = KEYS.map((k) => p?.[k]).filter((l): l is readonly number[] => !!l && l.length > 0);
  if (lines.length === 0) return { min: [], max: [], count: MIN_FORECAST_COUNT };
  const count = Math.max(MIN_FORECAST_COUNT, Math.min(...lines.map((l) => l.length)));
  const at = (i: number) => lines.filter((l) => i < l.length).map((l) => l[i]!);
  const min = Array.from({ length: count }, (_, i) => {
    const v = at(i);
    return v.length ? Math.min(...v) : 0;
  });
  const max = Array.from({ length: count }, (_, i) => {
    const v = at(i);
    return v.length ? Math.max(...v) : 0;
  });
  return { min, max, count };
}

/** Lowest predicted glucose when the algorithm does not report oref's minPredBG. */
export function lowestPrediction(p: Predictions | undefined | null): number | null {
  const all = KEYS.flatMap((k) => p?.[k] ?? []);
  return all.length ? Math.min(...all) : null;
}
