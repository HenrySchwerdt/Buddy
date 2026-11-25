/**
 * Pure statistics ported from Trio's Stat module (StatStateModel+Setup/*, GlucoseSectorChart,
 * GlucoseMetricsView, GRICalculator, LoopChartSetup). Formulas, indexing and rounding follow
 * Trio so the numbers match Trio for the same data. All glucose values are mg/dL.
 */
import { computeGlucoseStats, insulinStats, type CarbEntry, type GlucoseReading, type InsulinDose, type LoopRun, type TherapyProfile } from '@buddy/core';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_LOOPS_PER_DAY = 288;

/** Duration picker with "Today" (StatsTimeIntervalWithToday). */
export type IntervalWithToday = 'today' | 'day' | 'week' | 'month' | 'total';
/** Duration picker without "Today" (StatsTimeInterval). */
export type Interval = Exclude<IntervalWithToday, 'today'>;

export const INTERVALS_WITH_TODAY: readonly { value: IntervalWithToday; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'day', label: 'D' },
  { value: 'week', label: 'W' },
  { value: 'month', label: 'M' },
  { value: 'total', label: '3 M' },
];
export const INTERVALS: readonly { value: Interval; label: string }[] = INTERVALS_WITH_TODAY.filter(
  (o): o is { value: Interval; label: string } => o.value !== 'today',
);

// ---------------------------------------------------------------- local calendar helpers

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfHour(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

export function addDays(t: number, days: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export const hourOf = (t: number): number => new Date(t).getHours();

/** Start of the data window for an interval (Trio's glucoseForStats* / loop predicates). */
export function intervalStart(interval: IntervalWithToday, now: number): number {
  switch (interval) {
    case 'today':
      return startOfDay(now);
    case 'day':
      return now - DAY_MS;
    case 'week':
      return now - 7 * DAY_MS;
    case 'month':
      return now - 30 * DAY_MS;
    case 'total':
      return now - 90 * DAY_MS;
  }
}

/** Calendar days between two instants (Calendar.dateComponents([.day])). */
function calendarDaysBetween(from: number, to: number): number {
  return Math.floor((to - from) / DAY_MS);
}

// ---------------------------------------------------------------- medians / percentiles

/** StatChartUtils.medianCalculation: integer median (even counts use integer division). */
export function trioIntMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = values.map((v) => Math.round(v)).sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 0 ? Math.trunc((s[n / 2 - 1]! + s[n / 2]!) / 2) : s[Math.floor(n / 2)]!;
}

// ---------------------------------------------------------------- AGP (percentile by time)

export interface HourlyStats {
  readonly hour: number;
  readonly median: number;
  readonly p10: number;
  readonly p25: number;
  readonly p75: number;
  readonly p90: number;
}

/** AreaChartSetup.computeHourlyStats: index-based percentiles per hour of day; 0 = no data. */
export function hourlyStats(readings: readonly GlucoseReading[]): HourlyStats[] {
  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const r of readings) byHour[hourOf(r.date)]!.push(r.value);
  return byHour.map((vals, hour) => {
    const v = [...vals].sort((a, b) => a - b);
    const n = v.length;
    if (n === 0) return { hour, median: 0, p10: 0, p25: 0, p75: 0, p90: 0 };
    const median = n % 2 === 0 ? (v[n / 2 - 1]! + v[n / 2]!) / 2 : v[Math.floor(n / 2)]!;
    const at = (p: number) => v[Math.floor(n * p)]!;
    return { hour, median, p10: at(0.1), p25: at(0.25), p75: at(0.75), p90: at(0.9) };
  });
}

// ---------------------------------------------------------------- distribution by time

export interface RangeBand {
  readonly key: string;
  readonly lo: number;
  readonly hi: number;
}

/** StackedChartSetup ranges, bottom to top. Bounds are mg/dL for labels; `test` decides membership. */
export function distributionBands(bottom: number, top: number): readonly (RangeBand & { test: (g: number) => boolean })[] {
  return [
    { key: 'vlow', lo: 0, hi: 54, test: (g) => g <= 54 },
    { key: 'low', lo: 54, hi: bottom, test: (g) => g > 54 && g < bottom },
    { key: 'tight', lo: bottom, hi: top, test: (g) => g >= bottom && g <= top },
    { key: 'inrange', lo: top, hi: 180, test: (g) => g > top && g <= 180 },
    { key: 'high1', lo: 180, hi: 200, test: (g) => g > 180 && g <= 200 },
    { key: 'high2', lo: 200, hi: 220, test: (g) => g > 200 && g <= 220 },
    { key: 'vhigh', lo: 220, hi: Infinity, test: (g) => g > 220 },
  ];
}

/** Per hour and band: Int(readings in band / days with data in that hour × 100) (Trio). */
export function glucoseRangeStats(readings: readonly GlucoseReading[], bottom = 70, top = 140): { key: string; values: number[] }[] {
  const days: Set<number>[] = Array.from({ length: 24 }, () => new Set());
  for (const r of readings) days[hourOf(r.date)]!.add(startOfDay(r.date));
  return distributionBands(bottom, top).map((band) => {
    const counts = new Array<number>(24).fill(0);
    for (const r of readings) if (band.test(Math.round(r.value))) counts[hourOf(r.date)]! += 1;
    return { key: band.key, values: counts.map((c, h) => (days[h]!.size > 0 ? Math.trunc((c / days[h]!.size) * 100) : 0)) };
  });
}

// ---------------------------------------------------------------- TIR ring + metrics

export interface SectorStats {
  readonly total: number;
  /** Fractions 0…1 (count based, like Trio). */
  readonly inRange: number;
  readonly tight: number;
  readonly high: number;
  readonly low: number;
  readonly average: number;
  readonly median: number;
  readonly counts: { readonly high: number; readonly inRange: number; readonly low: number };
}

export function sectorStats(readings: readonly GlucoseReading[], bottom = 70, top = 140, highLimit = 180): SectorStats | null {
  const g = readings.map((r) => Math.round(r.value));
  const total = g.length;
  if (total === 0) return null;
  const count = (f: (v: number) => boolean) => g.filter(f).length;
  const high = count((v) => v > highLimit);
  const low = count((v) => v < bottom);
  return {
    total,
    inRange: count((v) => v >= bottom && v <= highLimit) / total,
    tight: count((v) => v >= bottom && v <= top) / total,
    high: high / total,
    low: low / total,
    average: g.reduce((a, b) => a + b, 0) / total,
    median: trioIntMedian(g),
    counts: { high, inRange: total - high - low, low },
  };
}

export type SectorRange = 'high' | 'inRange' | 'low';

export interface RangeDetail {
  readonly range: SectorRange;
  readonly title: string;
  /** First two are percentage rows, the rest are Average/Median/SD (mg/dL). */
  readonly percentages: readonly { label: string; fraction: number }[];
  readonly average: number;
  readonly median: number;
  readonly sd: number;
}

function detailStats(values: readonly number[]): { average: number; median: number; sd: number } {
  if (values.length === 0) return { average: 0, median: 0, sd: 0 };
  const average = Math.trunc(values.reduce((a, b) => a + b, 0) / values.length);
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - average) ** 2, 0) / values.length);
  return { average, median: trioIntMedian(values), sd };
}

/** GlucoseSectorChart.getDetailedData. Labels carry mg/dL bounds; the view formats them. */
export function rangeDetail(readings: readonly GlucoseReading[], range: SectorRange, fmt: (mgdl: number) => string, bottom = 70, top = 140, highLimit = 180): RangeDetail {
  const g = readings.map((r) => Math.round(r.value));
  const total = Math.max(1, g.length);
  const frac = (f: (v: number) => boolean) => g.filter(f).length / total;
  switch (range) {
    case 'high':
      return {
        range,
        title: 'High Glucose',
        percentages: [
          { label: `Very High (>${fmt(250)})`, fraction: frac((v) => v > 250) },
          { label: `High (${fmt(highLimit)}-${fmt(250)})`, fraction: frac((v) => v > highLimit && v <= 250) },
        ],
        ...detailStats(g.filter((v) => v > highLimit)),
      };
    case 'inRange':
      return {
        range,
        title: 'In Range',
        percentages: [
          { label: `TIR (${fmt(bottom)}-${fmt(highLimit)})`, fraction: frac((v) => v >= bottom && v <= highLimit) },
          { label: `TITR (${fmt(bottom)}-${fmt(top)})`, fraction: frac((v) => v >= bottom && v <= top) },
        ],
        ...detailStats(g.filter((v) => v >= bottom && v <= highLimit)),
      };
    case 'low':
      return {
        range,
        title: 'Low Glucose',
        percentages: [
          { label: `Low (${fmt(54)}-${fmt(bottom)})`, fraction: frac((v) => v > 54 && v < bottom) },
          { label: `Very Low (<${fmt(54)})`, fraction: frac((v) => v <= 54) },
        ],
        ...detailStats(g.filter((v) => v < bottom)),
      };
  }
}

export interface GlucoseMetrics {
  /** eA1c NGSP, %. */
  readonly ngsp: number;
  readonly ifcc: number;
  /** GMI, %. */
  readonly gmi: number;
  readonly gmiMmolMol: number;
  /** mg/dL, sample SD. */
  readonly sd: number;
  /** % */
  readonly cv: number;
  readonly days: number;
}

/** GlucoseMetricsView.calculateGlucoseStatistics (needs > 1 reading, else zeros). */
export function glucoseMetrics(readings: readonly GlucoseReading[]): GlucoseMetrics {
  const zero: GlucoseMetrics = { ngsp: 0, ifcc: 0, gmi: 0, gmiMmolMol: 0, sd: 0, cv: 0, days: 0 };
  if (readings.length === 0) return zero;
  const dates = readings.map((r) => r.date);
  const first = Math.min(...dates);
  const last = Math.max(...dates);
  const days = (last - first) / DAY_MS;
  if (readings.length < 2) return { ...zero, days };
  const s = computeGlucoseStats(readings, { from: first, to: last + 1 });
  if (s.mean === null) return { ...zero, days };
  const hasSpan = days > 0;
  const ngsp = hasSpan ? (s.a1cEstimate ?? 0) : 0;
  const gmi = hasSpan ? (s.gmi ?? 0) : 0;
  return {
    ngsp,
    ifcc: hasSpan ? 10.929 * (ngsp - 2.152) : 0,
    gmi,
    gmiMmolMol: hasSpan ? (gmi - 2.152) * 10.929 : 0,
    sd: s.sd ?? 0,
    cv: s.cv ?? 0,
    days,
  };
}

// ---------------------------------------------------------------- GRI

export interface GriResult {
  readonly veryLow: number;
  readonly low: number;
  readonly high: number;
  readonly veryHigh: number;
  readonly hypo: number;
  readonly hyper: number;
  readonly score: number;
  readonly zone: 'A' | 'B' | 'C' | 'D' | 'E';
}

/** GRICalculator (Klonoff 2023). Fixed thresholds 54/70/180/250 mg/dL. */
export function gri(readings: readonly GlucoseReading[]): GriResult | null {
  let count = 0;
  let veryLow = 0;
  let low = 0;
  let high = 0;
  let veryHigh = 0;
  for (const r of readings) {
    const v = Math.round(r.value);
    if (v <= 0) continue;
    count += 1;
    if (v < 54) veryLow += 1;
    else if (v < 70) low += 1;
    else if (v >= 251) veryHigh += 1;
    else if (v >= 181) high += 1;
  }
  if (count === 0) return null;
  const pct = 100 / count;
  const r = { veryLow: veryLow * pct, low: low * pct, high: high * pct, veryHigh: veryHigh * pct };
  const hypo = r.veryLow + 0.8 * r.low;
  const hyper = r.veryHigh + 0.5 * r.high;
  const score = Math.min(100, 3 * hypo + 1.6 * hyper);
  const zone = score <= 20 ? 'A' : score <= 40 ? 'B' : score <= 60 ? 'C' : score <= 80 ? 'D' : 'E';
  return { ...r, hypo, hyper, score, zone };
}

// ---------------------------------------------------------------- per-day glucose (box plot / distribution)

export interface DailyGlucose {
  readonly day: number;
  readonly count: number;
  readonly min: number;
  readonly p10: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
  readonly max: number;
  /** Fractions per distribution band key. */
  readonly bands: Readonly<Record<string, number>>;
}

export function dailyGlucose(readings: readonly GlucoseReading[], from: number, now: number, bottom = 70, top = 140): DailyGlucose[] {
  const out: DailyGlucose[] = [];
  const bands = distributionBands(bottom, top);
  for (let day = startOfDay(from); day <= now; day = addDays(day, 1)) {
    const next = addDays(day, 1);
    const v = readings.filter((r) => r.date >= day && r.date < next).map((r) => r.value).sort((a, b) => a - b);
    const n = v.length;
    const at = (p: number) => (n ? v[Math.min(n - 1, Math.floor(n * p))]! : 0);
    out.push({
      day,
      count: n,
      min: n ? v[0]! : 0,
      p10: at(0.1),
      p25: at(0.25),
      median: n ? (n % 2 === 0 ? (v[n / 2 - 1]! + v[n / 2]!) / 2 : v[Math.floor(n / 2)]!) : 0,
      p75: at(0.75),
      p90: at(0.9),
      max: n ? v[n - 1]! : 0,
      bands: Object.fromEntries(bands.map((b) => [b.key, n ? v.filter((x) => b.test(Math.round(x))).length / n : 0])),
    });
  }
  return out;
}

// ---------------------------------------------------------------- looping

export interface LoopStatsData {
  /** Successful loops (or per day for W/M/3M). */
  readonly loops: number;
  readonly loopPercentage: number;
  readonly glucose: number;
  readonly glucosePercentage: number;
  /** Seconds. */
  readonly medianDuration: number;
  /** Seconds between the end of one loop and the start of the next. */
  readonly medianInterval: number;
  readonly totalDays: number;
}

/** LoopChartSetup.getLoopStats. A loop with `error` counts as failed. */
export function loopStats(runs: readonly LoopRun[], glucose: readonly GlucoseReading[], interval: IntervalWithToday, now: number): LoopStatsData | null {
  const start = intervalStart(interval, now);
  const all = runs.filter((r) => r.date > start).sort((a, b) => b.date - a.date);
  if (all.length === 0) return null;
  const successful = all.filter((r) => !r.error).length;
  const numberOfDays = Math.max(1, calendarDaysBetween(start, now));
  const avgLoops = successful / numberOfDays;
  const avgGlucose = glucose.filter((g) => g.date >= start).length / numberOfDays;
  const durations = all.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
  const intervals = all
    .slice(0, -1)
    .map((newer, i) => (newer.date + newer.durationMs - all[i + 1]!.date) / 1000)
    .sort((a, b) => a - b);
  return {
    loops: Math.round(avgLoops),
    loopPercentage: (avgLoops / MAX_LOOPS_PER_DAY) * 100,
    glucose: Math.round(avgGlucose),
    glucosePercentage: (avgGlucose / MAX_LOOPS_PER_DAY) * 100,
    medianDuration: durations[Math.floor(durations.length / 2)] ?? 0,
    medianInterval: intervals[Math.floor(intervals.length / 2)] ?? 0,
    totalDays: numberOfDays,
  };
}

// ---------------------------------------------------------------- bar-chart buckets (TDD, bolus, meals)

export interface Bucket {
  readonly date: number;
  readonly values: readonly number[];
}

/** Bucket starts: hours of the last `HOURLY_DAYS` days for D, otherwise days of the last 90 days. */
export const HOURLY_DAYS = 7;
export const DAILY_DAYS = 90;

export function bucketStarts(interval: Interval, now: number): number[] {
  const today = startOfDay(now);
  const out: number[] = [];
  if (interval === 'day') {
    const end = addDays(today, 1);
    for (let t = addDays(today, -(HOURLY_DAYS - 1)); t < end; t += HOUR_MS) out.push(t);
  } else {
    for (let i = DAILY_DAYS - 1; i >= 0; i--) out.push(addDays(today, -i));
  }
  return out;
}

const bucketEnd = (interval: Interval, start: number) => (interval === 'day' ? start + HOUR_MS : addDays(start, 1));

/** Total insulin per bucket: boluses + SMBs + delivered basal (scheduled minus overridden plus temps). */
export function tddBuckets(doses: readonly InsulinDose[], profile: TherapyProfile, interval: Interval, now: number): Bucket[] {
  const firstDose = doses.reduce((m, d) => Math.min(m, d.date), Infinity);
  return bucketStarts(interval, now).map((date) => {
    const to = Math.min(bucketEnd(interval, date), now);
    if (!Number.isFinite(firstDose) || to <= date || to <= firstDose) return { date, values: [0] };
    const from = Math.max(date, firstDose);
    const s = insulinStats(doses, profile, from, to);
    return { date, values: [s.totalDaily * s.days] };
  });
}

/** [manual, smb, external] per bucket. Buddy has no external insulin entries, so external is 0. */
export function bolusBuckets(doses: readonly InsulinDose[], interval: Interval, now: number): Bucket[] {
  return bucketStarts(interval, now).map((date) => {
    const to = bucketEnd(interval, date);
    let manual = 0;
    let smb = 0;
    let external = 0;
    for (const d of doses) {
      if (d.date < date || d.date >= to) continue;
      if (d.kind === 'bolus' && d.external) external += d.units;
      else if (d.kind === 'bolus') manual += d.units;
      if (d.kind === 'smb') smb += d.units;
    }
    return { date, values: [manual, smb, external] };
  });
}

/** [carbs] per bucket (fat/protein are not recorded by Buddy). */
export function mealBuckets(carbs: readonly CarbEntry[], interval: Interval, now: number): Bucket[] {
  return bucketStarts(interval, now).map((date) => {
    const to = bucketEnd(interval, date);
    return { date, values: [carbs.filter((c) => c.date >= date && c.date < to).reduce((a, c) => a + c.grams, 0)] };
  });
}

// ---------------------------------------------------------------- visible range (StatChartUtils)

export function visibleDomainMs(interval: Interval): number {
  return { day: 1, week: 7, month: 30, total: 90 }[interval] * DAY_MS;
}

/** StatChartUtils.getInitialScrollPosition. */
export function initialScrollPosition(interval: Interval, now: number): number {
  const today = startOfDay(now);
  const back = { day: 0, week: 6, month: 29, total: 89 }[interval];
  return addDays(today, -back) + 1000;
}

/** StatChartUtils.visibleDateRange. */
export function visibleDateRange(scroll: number, interval: Interval): { start: number; end: number } {
  if (interval === 'day') return { start: scroll, end: scroll + visibleDomainMs(interval) - 1000 };
  const sod = startOfDay(scroll);
  const start = scroll - sod > 12 * HOUR_MS ? addDays(sod, 1) : sod;
  const end = startOfDay(start + visibleDomainMs(interval) + 2 * HOUR_MS) - 1000;
  return { start, end };
}

/**
 * Average per day over the days with data in the range (Trio's cached averages); for D the
 * range is one day, so this is that day's total.
 */
export function averageOverDays(buckets: readonly Bucket[], interval: Interval, range: { start: number; end: number }, index = 0): number {
  const perDay = new Map<number, number>();
  for (const b of buckets) {
    if (b.date + (interval === 'day' ? HOUR_MS : DAY_MS) <= range.start || b.date > range.end) continue;
    const v = b.values[index] ?? 0;
    if (v <= 0) continue;
    const day = startOfDay(b.date);
    perDay.set(day, (perDay.get(day) ?? 0) + v);
  }
  if (perDay.size === 0) return 0;
  return [...perDay.values()].reduce((a, b) => a + b, 0) / perDay.size;
}

export function sumInRange(buckets: readonly Bucket[], range: { start: number; end: number }, index?: number): number {
  return buckets
    .filter((b) => b.date >= range.start && b.date <= range.end)
    .reduce((a, b) => a + (index === undefined ? b.values.reduce((x, y) => x + y, 0) : (b.values[index] ?? 0)), 0);
}
