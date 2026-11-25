import type { GlucoseReading } from '@buddy/core';

/** Lightweight last-24-h summary for the Home banner. */
export function dayStats(readings: readonly GlucoseReading[], now: number) {
  const v = readings.filter((r) => r.date > now - 24 * 3_600_000).map((r) => r.value);
  if (v.length === 0) return null;
  const pct = (f: (x: number) => boolean) => (v.filter(f).length / v.length) * 100;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    tbr54: pct((x) => x < 54),
    tbr70: pct((x) => x < 70),
    tir: pct((x) => x >= 70 && x <= 180),
    tar180: pct((x) => x > 180),
    tar250: pct((x) => x > 250),
    mean,
    gmi: 3.31 + 0.02392 * mean,
  };
}
