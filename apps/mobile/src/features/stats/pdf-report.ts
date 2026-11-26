/**
 * Statistics PDF report (Trio StatPDFExporter / ReportChartType) as self-contained HTML with inline
 * SVG charts, rendered to PDF by expo-print. Pure: every function returns strings.
 */
import type { DataSnapshot, GlucoseUnit, Schedule, TherapyProfile } from '@buddy/core';
import {
  bolusBuckets,
  dailyGlucose,
  distributionBands,
  glucoseMetrics,
  glucoseRangeStats,
  gri,
  hourlyStats,
  intervalStart,
  loopStats,
  mealBuckets,
  sectorStats,
  tddBuckets,
  type Bucket,
  type Interval,
} from './calc';
import { fixed, glucoseValue, pctOne, pctUpToOne } from './format';

export type ReportCategory = 'glucose' | 'insulin' | 'looping' | 'meals' | 'therapy';

export type ReportChartType =
  | 'glucoseDistributionByTime'
  | 'glucosePercentileByTime'
  | 'glucosePercentileByDay'
  | 'glucoseDistributionByDay'
  | 'glucoseGlycemiaRiskIndex'
  | 'insulinTotalDailyDose'
  | 'insulinBolusDistribution'
  | 'loopingPerformance'
  | 'mealsTotalMeals'
  | 'therapyBasalRates'
  | 'therapyGlucoseTargets'
  | 'therapyCarbRatios'
  | 'therapyInsulinSensitivities';

export const REPORT_CHARTS: readonly { type: ReportChartType; label: string; category: ReportCategory }[] = [
  { type: 'glucoseDistributionByTime', label: 'Distribution', category: 'glucose' },
  { type: 'glucosePercentileByTime', label: 'Percentile', category: 'glucose' },
  { type: 'glucosePercentileByDay', label: 'Percentile (by day)', category: 'glucose' },
  { type: 'glucoseDistributionByDay', label: 'Distribution (by day)', category: 'glucose' },
  { type: 'glucoseGlycemiaRiskIndex', label: 'Glycemia Risk Index', category: 'glucose' },
  { type: 'insulinTotalDailyDose', label: 'Total Daily Dose', category: 'insulin' },
  { type: 'insulinBolusDistribution', label: 'Bolus Distribution', category: 'insulin' },
  { type: 'loopingPerformance', label: 'Looping Performance', category: 'looping' },
  { type: 'mealsTotalMeals', label: 'Total Meals', category: 'meals' },
  { type: 'therapyBasalRates', label: 'Basal Rates', category: 'therapy' },
  { type: 'therapyGlucoseTargets', label: 'Glucose Targets', category: 'therapy' },
  { type: 'therapyCarbRatios', label: 'Carb Ratios', category: 'therapy' },
  { type: 'therapyInsulinSensitivities', label: 'Insulin Sensitivities', category: 'therapy' },
];

export const REPORT_CATEGORIES: readonly { category: ReportCategory; label: string }[] = [
  { category: 'glucose', label: 'Glucose' },
  { category: 'insulin', label: 'Insulin' },
  { category: 'looping', label: 'Looping' },
  { category: 'meals', label: 'Meals' },
  { category: 'therapy', label: 'Therapy Settings' },
];

const BY_DAY: ReadonlySet<ReportChartType> = new Set(['glucosePercentileByDay', 'glucoseDistributionByDay']);

/** Per-day charts need more than one day (Trio disables them for the single-day range). */
export const isPerDayChart = (t: ReportChartType) => BY_DAY.has(t);

/** Selected charts in menu order. */
export function orderCharts(selected: ReadonlySet<ReportChartType>): ReportChartType[] {
  return REPORT_CHARTS.map((c) => c.type).filter((t) => selected.has(t));
}

export interface ReportInput {
  readonly snap: DataSnapshot;
  readonly profile: TherapyProfile;
  readonly units: GlucoseUnit;
  readonly now: number;
  readonly range: Interval;
  readonly charts: readonly ReportChartType[];
  readonly patientName?: string;
  readonly eA1cMmolMol?: boolean;
}

const BOTTOM = 70;
const TOP = 140;
const HIGH = 180;

/** HTML-escape text that comes from the user (patient name, notes). */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const RANGE_NAME: Readonly<Record<Interval, string>> = { day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days', total: 'Last 3 months' };

const BAND_COLOR: Readonly<Record<string, string>> = { vlow: '#B3261E', low: '#E65C5C', tight: '#2E9E4F', inrange: '#7CCB7C', high1: '#E6C85C', high2: '#E6A15C', vhigh: '#C46B2B' };
const BAND_LABEL: Readonly<Record<string, string>> = { vlow: 'Very Low', low: 'Low', tight: 'Tight Range', inrange: 'In Range', high1: 'High', high2: 'High+', vhigh: 'Very High' };
const BLUE = '#0A84FF';
const W = 680;
const H = 200;
const PAD = { l: 40, r: 8, t: 8, b: 22 };

function svg(inner: string, height = H): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="100%" role="img">${inner}</svg>`;
}

function axisY(ticks: readonly number[], y: (v: number) => number, fmt: (v: number) => string): string {
  return ticks
    .map((t) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="#d0d4dc" stroke-width="0.5"/><text x="${PAD.l - 4}" y="${(y(t) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#555">${fmt(t)}</text>`)
    .join('');
}

const toUnit = (mgdl: number, units: GlucoseUnit) => (units === 'mg/dL' ? mgdl : mgdl / 18.0182);

/** AGP: 10-90 % and 25-75 % bands with the median over 24 hours. */
export function agpSvg(readings: DataSnapshot['glucose'], units: GlucoseUnit): string {
  const stats = hourlyStats(readings).filter((s) => s.median > 0);
  if (stats.length === 0) return noData();
  const lo = toUnit(40, units);
  const hi = toUnit(Math.max(HIGH, ...stats.map((s) => s.p90)), units);
  const x = (h: number) => PAD.l + (h / 23) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - ((v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const band = (a: 'p10' | 'p25', b: 'p90' | 'p75', fill: string) => {
    const up = stats.map((s) => `${x(s.hour).toFixed(1)},${y(toUnit(s[b], units)).toFixed(1)}`);
    const down = [...stats].reverse().map((s) => `${x(s.hour).toFixed(1)},${y(toUnit(s[a], units)).toFixed(1)}`);
    return `<polygon points="${[...up, ...down].join(' ')}" fill="${fill}"/>`;
  };
  const median = stats.map((s) => `${x(s.hour).toFixed(1)},${y(toUnit(s.median, units)).toFixed(1)}`).join(' ');
  const rules = [BOTTOM, TOP, HIGH].map((v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(toUnit(v, units)).toFixed(1)}" y2="${y(toUnit(v, units)).toFixed(1)}" stroke="#2E9E4F" stroke-dasharray="4 3" stroke-width="0.8"/>`).join('');
  const hours = [0, 6, 12, 18, 23].map((h) => `<text x="${x(h).toFixed(1)}" y="${H - 6}" font-size="9" text-anchor="middle" fill="#555">${String(h).padStart(2, '0')}:00</text>`).join('');
  const ticks = [BOTTOM, TOP, HIGH, 250, 300].filter((v) => toUnit(v, units) < hi).map((v) => toUnit(v, units));
  return svg(
    axisY(ticks, y, (v) => (units === 'mg/dL' ? v.toFixed(0) : v.toFixed(1))) +
      band('p10', 'p90', 'rgba(10,132,255,0.22)') +
      band('p25', 'p75', 'rgba(10,132,255,0.38)') +
      rules +
      `<polyline points="${median}" fill="none" stroke="${BLUE}" stroke-width="2"/>` +
      hours,
  );
}

function noData(): string {
  return '<p class="muted">No data for this range.</p>';
}

/** Generic stacked bars (fractions when `normalized`). */
export function stackedBarsSvg(buckets: readonly Bucket[], colors: readonly string[], labelOf: (b: Bucket, i: number) => string | null, opts: { normalized?: boolean; fmt?: (v: number) => string } = {}): string {
  if (buckets.length === 0) return noData();
  const totals = buckets.map((b) => b.values.reduce((a, v) => a + v, 0));
  const max = opts.normalized ? 1 : Math.max(...totals, 0.0001);
  const plotW = W - PAD.l - PAD.r;
  const slot = plotW / buckets.length;
  const bw = Math.max(1, slot * 0.78);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const ticks = opts.normalized ? [0, 0.5, 1] : [0, max / 2, max];
  const fmt = opts.fmt ?? ((v: number) => (opts.normalized ? `${Math.round(v * 100)}%` : fixed(v, v < 10 ? 1 : 0)));
  const bars = buckets
    .map((b, i) => {
      let acc = 0;
      return b.values
        .map((v, k) => {
          if (v <= 0) return '';
          const top = y(acc + v);
          const bot = y(acc);
          acc += v;
          return `<rect x="${(PAD.l + i * slot + (slot - bw) / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, bot - top).toFixed(1)}" fill="${colors[k] ?? '#888'}"/>`;
        })
        .join('');
    })
    .join('');
  const step = Math.max(1, Math.ceil(buckets.length / 8));
  const labels = buckets
    .map((b, i) => {
      const l = i % step === 0 ? labelOf(b, i) : null;
      return l ? `<text x="${(PAD.l + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" font-size="9" text-anchor="middle" fill="#555">${esc(l)}</text>` : '';
    })
    .join('');
  return svg(axisY(ticks, y, fmt) + bars + labels);
}

/** Box plot per day: 10-90 % whisker, 25-75 % box, median tick. */
export function dailyPercentileSvg(readings: DataSnapshot['glucose'], from: number, now: number, units: GlucoseUnit): string {
  const days = dailyGlucose(readings, from, now).filter((d) => d.count > 0);
  if (days.length === 0) return noData();
  const lo = toUnit(40, units);
  const hi = toUnit(Math.max(HIGH, ...days.map((d) => d.p90)), units);
  const plotW = W - PAD.l - PAD.r;
  const slot = plotW / days.length;
  const bw = Math.max(1, slot * 0.7);
  const y = (v: number) => H - PAD.b - ((v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const body = days
    .map((d, i) => {
      const cx = PAD.l + i * slot + slot / 2;
      const u = (v: number) => y(toUnit(v, units)).toFixed(1);
      return (
        `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${u(d.p90)}" y2="${u(d.p10)}" stroke="${BLUE}" stroke-width="1"/>` +
        `<rect x="${(cx - bw / 2).toFixed(1)}" y="${u(d.p75)}" width="${bw.toFixed(1)}" height="${Math.max(1, y(toUnit(d.p25, units)) - y(toUnit(d.p75, units))).toFixed(1)}" fill="rgba(10,132,255,0.4)"/>` +
        `<line x1="${(cx - bw / 2).toFixed(1)}" x2="${(cx + bw / 2).toFixed(1)}" y1="${u(d.median)}" y2="${u(d.median)}" stroke="${BLUE}" stroke-width="2"/>`
      );
    })
    .join('');
  const step = Math.max(1, Math.ceil(days.length / 8));
  const labels = days.map((d, i) => (i % step === 0 ? `<text x="${(PAD.l + i * slot + slot / 2).toFixed(1)}" y="${H - 6}" font-size="9" text-anchor="middle" fill="#555">${esc(shortDate(d.day))}</text>` : '')).join('');
  const ticks = [BOTTOM, HIGH, 250].filter((v) => toUnit(v, units) < hi).map((v) => toUnit(v, units));
  return svg(axisY(ticks, y, (v) => (units === 'mg/dL' ? v.toFixed(0) : v.toFixed(1))) + body + labels);
}

const shortDate = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });

function scheduleTable(title: string, schedule: Schedule, fmt: (v: number) => string): string {
  const mm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const rows = schedule.map((e) => `<tr><td>${mm(e.startMinute)}</td><td>${esc(fmt(e.value))}</td></tr>`).join('');
  return `<table><thead><tr><th>Start</th><th>${esc(title)}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function legend(items: readonly { label: string; color: string }[]): string {
  return `<p class="legend">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`).join('')}</p>`;
}

function metricsTable(readings: DataSnapshot['glucose'], units: GlucoseUnit, mmolMol: boolean): string {
  const s = sectorStats(readings, BOTTOM, TOP, HIGH);
  if (!s) return '';
  const m = glucoseMetrics(readings);
  const sd = units === 'mg/dL' ? fixed(m.sd, 0) : fixed(m.sd / 18.0182, 1);
  const cells: [string, string][] = [
    [`In range ${glucoseValue(BOTTOM, units)}-${glucoseValue(HIGH, units)}`, pctUpToOne(s.inRange)],
    [`Tight ${glucoseValue(BOTTOM, units)}-${glucoseValue(TOP, units)}`, pctUpToOne(s.tight)],
    [`Above ${glucoseValue(HIGH, units)}`, pctUpToOne(s.high)],
    [`Below ${glucoseValue(BOTTOM, units)}`, pctUpToOne(s.low)],
    ['Average', `${glucoseValue(s.average, units)} ${units}`],
    ['Median', `${glucoseValue(s.median, units)} ${units}`],
    ['eA1c', mmolMol ? `${fixed(m.ifcc, 1)} mmol/mol` : pctOne(m.ngsp / 100)],
    ['GMI', mmolMol ? `${fixed(m.gmiMmolMol, 1)} mmol/mol` : pctOne(m.gmi / 100)],
    ['SD', sd],
    ['CV', pctOne(m.cv / 100)],
  ];
  return `<table class="kv"><tbody>${cells.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
}

function chartSection(type: ReportChartType, input: ReportInput): { title: string; body: string } {
  const { snap, profile, units, now, range } = input;
  const from = intervalStart(range, now);
  const readings = snap.glucose.filter((g) => g.date >= from && g.date <= now);
  const label = REPORT_CHARTS.find((c) => c.type === type)!.label;
  const inRange = (b: Bucket) => b.date >= from;
  switch (type) {
    case 'glucosePercentileByTime':
      return { title: `Glucose ${label}`, body: agpSvg(readings, units) + legend([{ label: '10-90%', color: 'rgba(10,132,255,0.22)' }, { label: '25-75%', color: 'rgba(10,132,255,0.38)' }, { label: 'Median', color: BLUE }]) + metricsTable(readings, units, input.eA1cMmolMol === true) };
    case 'glucoseDistributionByTime': {
      const bands = distributionBands(BOTTOM, TOP);
      const hourly = glucoseRangeStats(readings, BOTTOM, TOP);
      const buckets: Bucket[] = Array.from({ length: 24 }, (_, h) => ({ date: h, values: bands.map((b) => (hourly.find((r) => r.key === b.key)?.values[h] ?? 0) / 100) }));
      return {
        title: `Glucose ${label}`,
        body: stackedBarsSvg(buckets, bands.map((b) => BAND_COLOR[b.key]!), (b) => (b.date % 6 === 0 ? `${String(b.date).padStart(2, '0')}:00` : null), { normalized: true }) + legend(bands.map((b) => ({ label: BAND_LABEL[b.key]!, color: BAND_COLOR[b.key]! }))) + metricsTable(readings, units, input.eA1cMmolMol === true),
      };
    }
    case 'glucosePercentileByDay':
      return { title: `Glucose ${label}`, body: dailyPercentileSvg(snap.glucose, from, now, units) };
    case 'glucoseDistributionByDay': {
      const bands = distributionBands(BOTTOM, TOP);
      const days = dailyGlucose(snap.glucose, from, now, BOTTOM, TOP).filter((d) => d.count > 0);
      const buckets: Bucket[] = days.map((d) => ({ date: d.day, values: bands.map((b) => d.bands[b.key] ?? 0) }));
      return { title: `Glucose ${label}`, body: stackedBarsSvg(buckets, bands.map((b) => BAND_COLOR[b.key]!), (b) => shortDate(b.date), { normalized: true }) + legend(bands.map((b) => ({ label: BAND_LABEL[b.key]!, color: BAND_COLOR[b.key]! }))) };
    }
    case 'glucoseGlycemiaRiskIndex': {
      const r = gri(readings);
      const body = r
        ? `<p class="big">GRI ${fixed(r.score, 0)} <small>Zone ${r.zone}</small></p><table class="kv"><tbody><tr><td>Very Low</td><td>${fixed(r.veryLow, 1)}%</td></tr><tr><td>Low</td><td>${fixed(r.low, 1)}%</td></tr><tr><td>High</td><td>${fixed(r.high, 1)}%</td></tr><tr><td>Very High</td><td>${fixed(r.veryHigh, 1)}%</td></tr></tbody></table>`
        : noData();
      return { title: label, body };
    }
    case 'insulinTotalDailyDose': {
      const buckets = tddBuckets(snap.doses, profile, range, now).filter(inRange);
      const total = buckets.reduce((a, b) => a + (b.values[0] ?? 0), 0);
      const days = Math.max(1, (now - from) / 86_400_000);
      return { title: label, body: stackedBarsSvg(buckets, [BLUE], (b) => shortDate(b.date)) + `<p class="muted">Average ${fixed(total / days, 1)} U per day</p>` };
    }
    case 'insulinBolusDistribution': {
      const buckets = bolusBuckets(snap.doses, range, now).filter(inRange);
      return { title: label, body: stackedBarsSvg(buckets, ['#2E9E4F', '#E6A15C', '#A15CE6'], (b) => shortDate(b.date)) + legend([{ label: 'Manual', color: '#2E9E4F' }, { label: 'SMB', color: '#E6A15C' }, { label: 'External', color: '#A15CE6' }]) };
    }
    case 'loopingPerformance': {
      const s = loopStats(snap.loopRuns, snap.glucose, range, now);
      const body = s
        ? `<table class="kv"><tbody><tr><td>Loops${range === 'day' ? '' : ' per day'}</td><td>${s.loops} (${pctUpToOne(s.loopPercentage / 100)})</td></tr><tr><td>Readings${range === 'day' ? '' : ' per day'}</td><td>${s.glucose} (${pctUpToOne(s.glucosePercentage / 100)})</td></tr><tr><td>Median loop time</td><td>${fixed(s.medianDuration, 1)} s</td></tr><tr><td>Median interval</td><td>${fixed(s.medianInterval / 60, 1)} min</td></tr></tbody></table>`
        : noData();
      return { title: label, body };
    }
    case 'mealsTotalMeals': {
      const buckets = mealBuckets(snap.carbs, range, now).filter(inRange);
      return { title: label, body: stackedBarsSvg(buckets, ['#E6A15C'], (b) => shortDate(b.date), { fmt: (v) => fixed(v, 0) }) + legend([{ label: 'Carbs (g)', color: '#E6A15C' }]) };
    }
    case 'therapyBasalRates':
      return { title: label, body: scheduleTable('Rate (U/h)', profile.basal, (v) => fixed(v, 3)) };
    case 'therapyGlucoseTargets':
      return { title: label, body: scheduleTable(`Target (${units})`, profile.target.map((e) => ({ startMinute: e.startMinute, value: e.value.low })), (v) => glucoseValue(v, units)).replace('</tbody>', '</tbody>') };
    case 'therapyCarbRatios':
      return { title: label, body: scheduleTable('Ratio (g/U)', profile.carbRatio, (v) => fixed(v, 1)) };
    case 'therapyInsulinSensitivities':
      return { title: label, body: scheduleTable(`Sensitivity (${units}/U)`, profile.isf, (v) => glucoseValue(v, units)) };
  }
}

const STYLE = `
body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;margin:0;padding:24px;font-size:12px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:15px;margin:0 0 8px}
.page{page-break-after:always;break-after:page;padding-bottom:12px}.page:last-child{page-break-after:auto}
.muted{color:#666}.sub{color:#555;margin:0 0 14px}
table{border-collapse:collapse;margin:10px 0;min-width:240px}td,th{border-bottom:1px solid #ddd;padding:4px 10px;text-align:left}
.kv td:last-child{text-align:right;font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:10px;color:#555}.legend i{display:inline-block;width:9px;height:9px;border-radius:5px;margin-right:4px}
.big{font-size:28px;font-weight:700;margin:6px 0}.big small{font-size:14px;font-weight:400;color:#555}
footer{font-size:9px;color:#888;margin-top:10px}`;

/** Full HTML document: one page per chart, in menu order. */
export function buildReportHtml(input: ReportInput): string {
  const usesRange = (t: ReportChartType) => !t.startsWith('therapy');
  const generated = new Date(input.now).toLocaleString();
  const header = (title: string, type: ReportChartType) =>
    `<h1>${esc(title)}</h1><p class="sub">${input.patientName ? `${esc(input.patientName)} · ` : ''}${usesRange(type) ? `${RANGE_NAME[input.range]} · ` : ''}Generated ${esc(generated)}</p>`;
  const pages = input.charts
    .map((type) => {
      const { title, body } = chartSection(type, input);
      const cat = REPORT_CATEGORIES.find((c) => c.category === REPORT_CHARTS.find((r) => r.type === type)!.category)!.label;
      return `<section class="page">${header(`${cat}: ${title}`, type)}${body}<footer>Buddy is experimental research software and not a medical device.</footer></section>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${STYLE}</style></head><body>${pages || '<p class="muted">No charts selected.</p>'}</body></html>`;
}
