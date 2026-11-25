import { insulinStats, type DataSnapshot, type GlucoseUnit, type InsulinDose, type TherapyProfile } from '@buddy/core';
import { glucoseMetrics, intervalStart, loopStats, sectorStats } from './calc';
import { fixed, glucoseValue, pctOne, pctUpToOne } from './format';

/**
 * Plain-text statistics summary for the share sheet. Trio exports a PDF report
 * (StatExportMenuView); Buddy shares the same headline numbers as text.
 */
export function buildStatsReport(snap: DataSnapshot, profile: TherapyProfile, units: GlucoseUnit, now: number): string {
  const lines: string[] = ['Statistics', new Date(now).toLocaleString(), ''];
  for (const [label, interval] of [
    ['Last 24 h', 'day'],
    ['Last 7 days', 'week'],
    ['Last 30 days', 'month'],
  ] as const) {
    const from = intervalStart(interval, now);
    const readings = snap.glucose.filter((g) => g.date >= from && g.date <= now);
    const s = sectorStats(readings);
    lines.push(label);
    if (!s) {
      lines.push('  No glucose data');
    } else {
      const m = glucoseMetrics(readings);
      lines.push(`  TIR ${glucoseValue(70, units)}-${glucoseValue(180, units)}: ${pctUpToOne(s.inRange)}`);
      lines.push(`  TITR ${glucoseValue(70, units)}-${glucoseValue(140, units)}: ${pctUpToOne(s.tight)}`);
      lines.push(`  > ${glucoseValue(180, units)}: ${pctUpToOne(s.high)}   < ${glucoseValue(70, units)}: ${pctUpToOne(s.low)}`);
      lines.push(`  Average ${glucoseValue(s.average, units)} ${units}, Median ${glucoseValue(s.median, units)} ${units}`);
      lines.push(`  eA1c ${pctOne(m.ngsp / 100)}, GMI ${pctOne(m.gmi / 100)}, CV ${pctOne(m.cv / 100)}`);
    }
    const tdd = insulinStatsSafe(snap.doses, profile, from, now);
    if (tdd !== null) lines.push(`  TDD ${fixed(tdd, 1)} U/day`);
    const loop = loopStats(snap.loopRuns, snap.glucose, interval, now);
    if (loop) lines.push(`  Loops ${loop.loops}${interval === 'day' ? '' : ' per day'}, Success ${pctUpToOne(loop.loopPercentage / 100)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Average daily total insulin since the first recorded dose in [from, to); null without doses. */
function insulinStatsSafe(doses: readonly InsulinDose[], profile: TherapyProfile, from: number, to: number): number | null {
  const first = doses.reduce((m, d) => (d.date >= from ? Math.min(m, d.date) : m), Infinity);
  if (!Number.isFinite(first) || first >= to) return null;
  return insulinStats(doses, profile, Math.max(from, first), to).totalDaily;
}
