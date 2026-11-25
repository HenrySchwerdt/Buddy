/**
 * Glycemic and insulin statistics following the international consensus on CGM metrics
 * (Battelino et al., Diabetes Care 2019) and the AGP report.
 *
 * Time-in-range metrics are time-weighted: each reading represents the time until the next
 * reading, but a gap longer than 15 min is not counted (the reading then represents only one
 * nominal 5-min sample). Mean/SD/median are computed over the readings themselves.
 */
import { totalDelivered } from './insulin';
import { minuteOfDay } from './schedule';
import { HOUR, MINUTE } from './units';
export const DAY = 24 * HOUR;
const SAMPLE_MINUTES = 5;
const MAX_GAP_MINUTES = 15;
/** Values at or below this are sensor errors / placeholders, not glucose. */
const MIN_VALID_MGDL = 39;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function validSorted(readings, from, to) {
    return readings
        .filter((r) => r.date >= from && r.date < to && Number.isFinite(r.value) && r.value >= MIN_VALID_MGDL)
        .sort((a, b) => a.date - b.date);
}
/** Minutes each reading represents (see module doc). */
export function readingWeights(sorted, to) {
    return sorted.map((r, i) => {
        const next = sorted[i + 1];
        const gap = ((next ? next.date : to) - r.date) / MINUTE;
        if (!next)
            return Math.min(SAMPLE_MINUTES, gap);
        return gap > MAX_GAP_MINUTES ? SAMPLE_MINUTES : gap;
    });
}
/** Linear-interpolated percentile (numpy default / Excel PERCENTILE.INC); `p` in 0…100. */
export function percentile(sortedValues, p) {
    const n = sortedValues.length;
    if (n === 0)
        return null;
    const rank = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    const a = sortedValues[lo];
    const b = sortedValues[hi];
    return a + (b - a) * (rank - lo);
}
function emptyStats() {
    return {
        count: 0, coverage: 0, mean: null, median: null, sd: null, cv: null, gmi: null, a1cEstimate: null,
        tir: null, titr: null, tbr: null, tbrVeryLow: null, tar: null, tarVeryHigh: null, min: null, max: null,
    };
}
export function computeGlucoseStats(readings, options) {
    const { from, to, low = 70, high = 180, veryLow = 54, veryHigh = 250, tightHigh = 140 } = options;
    if (!(to > from))
        throw new RangeError('computeGlucoseStats: `to` must be after `from`');
    const sorted = validSorted(readings, from, to);
    if (sorted.length === 0)
        return emptyStats();
    const values = sorted.map((r) => r.value);
    const n = values.length;
    const mean = sum(values) / n;
    const sd = n > 1 ? Math.sqrt(sum(values.map((v) => (v - mean) ** 2)) / (n - 1)) : 0;
    const ordered = [...values].sort((a, b) => a - b);
    const weights = readingWeights(sorted, to);
    const totalWeight = sum(weights);
    const pct = (pred) => totalWeight > 0 ? (100 * sum(values.map((v, i) => (pred(v) ? weights[i] : 0)))) / totalWeight : 0;
    const expected = (to - from) / (SAMPLE_MINUTES * MINUTE);
    return {
        count: n,
        coverage: Math.min(100, (100 * n) / expected),
        mean,
        median: percentile(ordered, 50),
        sd,
        cv: mean > 0 ? (100 * sd) / mean : null,
        gmi: 3.31 + 0.02392 * mean,
        a1cEstimate: (mean + 46.7) / 28.7,
        tir: pct((v) => v >= low && v <= high),
        titr: pct((v) => v >= low && v <= tightHigh),
        tbr: pct((v) => v < low),
        tbrVeryLow: pct((v) => v < veryLow),
        tar: pct((v) => v > high),
        tarVeryHigh: pct((v) => v > veryHigh),
        min: ordered[0],
        max: ordered[n - 1],
    };
}
/** Start of the local day containing `date`, as epoch ms. */
export function localDayStart(date, utcOffsetMinutes = 0) {
    const offset = utcOffsetMinutes * MINUTE;
    return Math.floor((date + offset) / DAY) * DAY - offset;
}
/** Per local day stats for the last `days` days (oldest first), including the anchor's day. */
export function dailyBreakdown(readings, days, utcOffsetMinutes = 0, options = {}) {
    if (!Number.isInteger(days) || days < 1)
        throw new RangeError('dailyBreakdown: `days` must be a positive integer');
    const { now, ...ranges } = options;
    const anchor = now ?? readings.reduce((m, r) => (m === null || r.date > m ? r.date : m), null);
    if (anchor === null)
        return [];
    const lastStart = localDayStart(anchor, utcOffsetMinutes);
    return Array.from({ length: days }, (_, i) => {
        const from = lastStart - (days - 1 - i) * DAY;
        const to = from + DAY;
        const day = new Date(from + utcOffsetMinutes * MINUTE).toISOString().slice(0, 10);
        return { day, from, to, stats: computeGlucoseStats(readings, { ...ranges, from, to }) };
    });
}
/** Exact integral of the scheduled basal (U) over [from, to). */
export function scheduledBasal(profile, from, to) {
    const offset = profile.utcOffsetMinutes ?? 0;
    let total = 0;
    let t = from;
    while (t < to) {
        const m = minuteOfDay(t, offset);
        const msIntoDay = (((t + offset * MINUTE) % DAY) + DAY) % DAY;
        const nextStart = profile.basal.find((e) => e.startMinute > m)?.startMinute ?? 1440;
        const segEnd = Math.min(to, t + nextStart * MINUTE - msIntoDay);
        let rate = profile.basal[0]?.value ?? 0;
        for (const e of profile.basal)
            if (e.startMinute <= m)
                rate = e.value;
        total += (rate * (segEnd - t)) / HOUR;
        t = segEnd;
    }
    return total;
}
/** Intervals in which a temp basal or suspend overrides the schedule (same truncation as `totalDelivered`). */
function overriddenIntervals(doses, from, to) {
    const events = doses.filter((d) => d.kind === 'tempBasal' || d.kind === 'suspend').sort((a, b) => a.date - b.date);
    const out = [];
    events.forEach((d, i) => {
        const next = events.slice(i + 1).find((e) => e.date > d.date);
        const start = Math.max(d.date, from);
        const end = Math.min(d.date + d.durationMin * MINUTE, next ? next.date : Infinity, to);
        if (end > start)
            out.push([start, end]);
    });
    return out;
}
export function insulinStats(doses, profile, from, to) {
    if (!(to > from))
        throw new RangeError('insulinStats: `to` must be after `from`');
    const days = (to - from) / DAY;
    const inWindow = (d) => d.date >= from && d.date < to;
    const bolus = sum(doses.filter((d) => d.kind === 'bolus' && inWindow(d)).map((d) => (d.kind === 'bolus' ? d.units : 0)));
    const smb = sum(doses.filter((d) => d.kind === 'smb' && inWindow(d)).map((d) => (d.kind === 'smb' ? d.units : 0)));
    const basalEvents = doses.filter((d) => d.kind === 'tempBasal' || d.kind === 'suspend');
    const tempDelivered = totalDelivered(basalEvents, from, to);
    const overridden = sum(overriddenIntervals(basalEvents, from, to).map(([a, b]) => scheduledBasal(profile, a, b)));
    const basal = tempDelivered + scheduledBasal(profile, from, to) - overridden;
    const total = basal + bolus + smb;
    return {
        days,
        totalDaily: total / days,
        basal: basal / days,
        bolus: bolus / days,
        smb: smb / days,
        basalPercent: total > 0 ? (100 * basal) / total : null,
    };
}
/** Ambulatory Glucose Profile: percentiles per time-of-day bucket across all days. */
export function agpPercentiles(readings, bucketMinutes = 30, utcOffsetMinutes = 0) {
    if (!Number.isInteger(bucketMinutes) || bucketMinutes <= 0 || 1440 % bucketMinutes !== 0) {
        throw new RangeError('agpPercentiles: `bucketMinutes` must be a positive divisor of 1440');
    }
    const buckets = Array.from({ length: 1440 / bucketMinutes }, () => []);
    for (const r of readings) {
        if (!Number.isFinite(r.value) || r.value < MIN_VALID_MGDL)
            continue;
        buckets[Math.floor(minuteOfDay(r.date, utcOffsetMinutes) / bucketMinutes)].push(r.value);
    }
    return buckets.map((values, i) => {
        const v = [...values].sort((a, b) => a - b);
        return {
            startMinute: i * bucketMinutes,
            count: v.length,
            p5: percentile(v, 5),
            p25: percentile(v, 25),
            p50: percentile(v, 50),
            p75: percentile(v, 75),
            p95: percentile(v, 95),
        };
    });
}
