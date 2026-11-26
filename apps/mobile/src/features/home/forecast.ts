import { MINUTE, type Predictions } from '@buddy/core';

export const FORECAST_KEYS = ['iob', 'zt', 'cob', 'uam', 'main'] as const;
export type ForecastKey = (typeof FORECAST_KEYS)[number];
/** ForecastView draws nothing past this far into the future. */
const FORECAST_HORIZON_MS = 2.5 * 60 * MINUTE;
const STEP = 5 * MINUTE;

export interface ForecastLine {
  readonly key: ForecastKey;
  readonly points: readonly { t: number; v: number }[];
}

export interface ConePoint {
  readonly t: number;
  readonly lo: number;
  readonly hi: number;
}

function curves(p: Predictions | undefined): { key: ForecastKey; values: readonly number[] }[] {
  return FORECAST_KEYS.flatMap((key) => {
    const values = p?.[key];
    return values && values.length > 1 ? [{ key, values }] : [];
  });
}

/** Individual oref curves, clipped to the 2.5 h horizon (`drawForecastsLines`). */
export function forecastLines(p: Predictions | undefined, start: number, now: number): ForecastLine[] {
  return curves(p).map(({ key, values }) => ({
    key,
    points: values.map((v, i) => ({ t: start + i * STEP, v })).filter((pt) => pt.t <= now + FORECAST_HORIZON_MS),
  }));
}

/** Min / max over all curves per step (`drawForecastsCone`); a zero-width step is widened by 1 mg/dL each way. */
export function forecastCone(p: Predictions | undefined, start: number, now: number): ConePoint[] {
  const cs = curves(p);
  const len = cs.reduce((m, c) => Math.max(m, c.values.length), 0);
  const out: ConePoint[] = [];
  for (let i = 0; i < len; i++) {
    const t = start + i * STEP;
    if (t > now + FORECAST_HORIZON_MS) break;
    const vals = cs.map((c) => c.values[Math.min(i, c.values.length - 1)]!);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    out.push(lo === hi ? { t, lo: lo - 1, hi: hi + 1 } : { t, lo, hi });
  }
  return out;
}
