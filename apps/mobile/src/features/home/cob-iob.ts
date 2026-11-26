import { carbsOnBoard, computeIob, MINUTE, type CarbEntry, type InsulinDose, type LoopRun, type TherapyProfile } from '@buddy/core';

/** MainChartHelper.scaledIobAmount: IOB shares the COB axis, so it is scaled up for visibility. */
export const scaledIob = (raw: number) => (raw > 0 ? raw * 8 : raw * 9);

export interface CobIobPoint {
  readonly t: number;
  readonly cob: number;
  readonly iob: number;
}

/** Determinations in the window, newest duplicates dropped (`filteredDeterminations`). */
export function historyPoints(runs: readonly LoopRun[], from: number, to: number): CobIobPoint[] {
  const seen = new Set<number>();
  return runs
    .filter((r) => r.date >= from && r.date <= to && !r.error)
    .filter((r) => (seen.has(r.date) ? false : (seen.add(r.date), true)))
    .map((r) => ({ t: r.date, cob: Math.round(r.cob), iob: r.iob }));
}

/** Dashed projection of IOB (decay of the doses) and COB (decay of the entries) from `anchor` to `end`, 5 minute steps. */
export function projectionPoints(doses: readonly InsulinDose[], carbs: readonly CarbEntry[], profile: TherapyProfile, anchor: number, end: number): CobIobPoint[] {
  const out: CobIobPoint[] = [];
  for (let t = anchor; t <= end; t += 5 * MINUTE) out.push({ t, cob: carbsOnBoard(carbs, t), iob: computeIob(doses, profile, t).iob });
  return out;
}

/** cobIobYDomain, with the default bounds of `yAxisChartDataCobChart` / `yAxisChartDataIobChart`. */
export function cobIobDomain(points: readonly CobIobPoint[]): { min: number; max: number } {
  const maxCob = points.length ? Math.max(...points.map((p) => p.cob)) : 0;
  const cobMax = points.length ? (maxCob === 0 ? 20 : maxCob + 20) : 20;
  const iobMin = points.length ? Math.min(...points.map((p) => p.iob)) : 0;
  const iobMax = points.length ? Math.max(...points.map((p) => p.iob)) : 5;
  return { min: Math.min(0, scaledIob(iobMin)), max: Math.max(cobMax, scaledIob(iobMax)) };
}
