/**
 * Glucose and system alarm engine. Pure and deterministic: the caller feeds the current
 * state plus the previous result's `active` list, and decides how to present `toNotify`.
 *
 * Kinds, thresholds and wording mirror Trio (`GlucoseAlertType`, `GlucoseAlertCoordinator`,
 * `NotLoopingMonitor`) where Trio has an equivalent; rate and device alerts follow common
 * CGM/pump defaults.
 */
import type { AlgorithmDecision } from './algorithm';
import { glucoseStatus } from './glucose';
import type { LoopRun } from './loop';
import { minuteOfDay } from './schedule';
import type { GlucoseReading, Millis, Predictions, PumpState } from './types';
import { formatGlucose, MINUTE, type GlucoseUnit } from './units';

/** Ordered by priority, highest first. */
export const ALERT_KINDS = [
  'urgentLow',
  'low',
  'forecastLow',
  'fallingFast',
  'notLooping',
  'staleData',
  'carbsRequired',
  'high',
  'risingFast',
  'pumpReservoirLow',
  'pumpBatteryLow',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly body: string;
  /** When the alert condition started (kept stable while the alert stays active). */
  readonly since: Millis;
  /** Last time this alert was included in `toNotify`; `null` if never. */
  readonly lastNotifiedAt: Millis | null;
}

interface KindBase {
  readonly enabled: boolean;
  /** Re-notify while still active after this many minutes; 0 = notify once. */
  readonly repeatMinutes: number;
}

export interface AlertSettings {
  readonly unit: GlucoseUnit;
  /** mg/dL margin a value must recover past the threshold before a glucose alert clears. */
  readonly hysteresisMgdl: number;
  /** Glucose-driven alerts only evaluate readings at most this old (minutes). */
  readonly maxReadingAgeMinutes: number;
  /** Loop predictions are only used while the loop run is at most this old (minutes). */
  readonly maxPredictionAgeMinutes: number;
  /** Minutes of local day; only `urgentLow` notifies inside the window. Wraps past midnight. */
  readonly quietHours: {
    readonly enabled: boolean;
    readonly startMinute: number;
    readonly endMinute: number;
    readonly utcOffsetMinutes: number;
  };
  readonly urgentLow: KindBase & { readonly threshold: number };
  readonly low: KindBase & { readonly threshold: number };
  readonly forecastLow: KindBase & { readonly threshold: number; readonly horizonMinutes: number };
  readonly high: KindBase & { readonly threshold: number };
  /** mg/dL per minute (positive). */
  readonly risingFast: KindBase & { readonly rateMgdlPerMin: number };
  /** mg/dL per minute (positive magnitude of the fall). */
  readonly fallingFast: KindBase & { readonly rateMgdlPerMin: number };
  readonly staleData: KindBase & { readonly minutes: number };
  /** Warning after `minutes`, escalates to critical after `criticalMinutes`. */
  readonly notLooping: KindBase & { readonly minutes: number; readonly criticalMinutes: number };
  readonly carbsRequired: KindBase & { readonly grams: number };
  readonly pumpReservoirLow: KindBase & { readonly units: number };
  readonly pumpBatteryLow: KindBase & { readonly percent: number };
}

/** Maximum snooze for urgent low (Trio's quick-snooze safety floor). */
export const URGENT_LOW_MAX_SNOOZE_MINUTES = 15;

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  unit: 'mg/dL',
  hysteresisMgdl: 5, // Trio recoveryMarginMgDL
  maxReadingAgeMinutes: 12, // Trio readingFreshnessWindow
  maxPredictionAgeMinutes: 15,
  quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 6 * 60, utcOffsetMinutes: 0 }, // Trio night 22:00–06:00
  urgentLow: { enabled: true, threshold: 54, repeatMinutes: 5 }, // Trio 54
  low: { enabled: true, threshold: 72, repeatMinutes: 15 }, // Trio 72
  forecastLow: { enabled: true, threshold: 72, horizonMinutes: 20, repeatMinutes: 20 }, // Trio 72 / 20 min
  high: { enabled: true, threshold: 270, repeatMinutes: 60 }, // Trio 270
  risingFast: { enabled: false, rateMgdlPerMin: 3, repeatMinutes: 30 },
  fallingFast: { enabled: false, rateMgdlPerMin: 3, repeatMinutes: 30 },
  staleData: { enabled: true, minutes: 20, repeatMinutes: 30 },
  notLooping: { enabled: true, minutes: 20, criticalMinutes: 120, repeatMinutes: 20 }, // Trio ladder 20…120
  carbsRequired: { enabled: true, grams: 10, repeatMinutes: 15 }, // Trio 10 g
  pumpReservoirLow: { enabled: true, units: 20, repeatMinutes: 240 },
  pumpBatteryLow: { enabled: true, percent: 20, repeatMinutes: 240 },
};

/** Snooze per kind: alerts of that kind do not notify before the timestamp. */
export type AlertSnoozes = Readonly<Partial<Record<AlertKind, Millis>>>;

export interface AlertInput {
  readonly now: Millis;
  /** Any order. */
  readonly glucose: readonly GlucoseReading[];
  readonly lastLoopRun: LoopRun | null;
  /**
   * Time of the last loop run without error. Defaults to `lastLoopRun.date` when that run
   * succeeded; pass it so a loop that keeps failing still raises `notLooping`.
   */
  readonly lastSuccessfulLoopAt?: Millis | null;
  readonly pump: PumpState | null;
  readonly settings: AlertSettings;
  readonly snoozes: AlertSnoozes;
  /** `active` from the previous evaluation (drives hysteresis, `since` and repeats). */
  readonly previouslyActive: readonly Alert[];
}

export interface AlertResult {
  readonly active: Alert[];
  readonly toNotify: Alert[];
}

type Condition = Omit<Alert, 'kind' | 'since' | 'lastNotifiedAt'> & { readonly since: Millis };

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Returns a new snooze map; urgent low is capped at 15 minutes from `now`. */
export function snoozeAlert(snoozes: AlertSnoozes, kind: AlertKind, until: Millis, now: Millis): AlertSnoozes {
  const capped = kind === 'urgentLow' ? Math.min(until, now + URGENT_LOW_MAX_SNOOZE_MINUTES * MINUTE) : until;
  return { ...snoozes, [kind]: capped };
}

/** An urgent-low snooze reaching further than the cap is ignored entirely (fail safe). */
export function isSnoozed(snoozes: AlertSnoozes, kind: AlertKind, now: Millis): boolean {
  const until = snoozes[kind];
  if (until === undefined || until <= now) return false;
  if (kind === 'urgentLow' && until > now + URGENT_LOW_MAX_SNOOZE_MINUTES * MINUTE) return false;
  return true;
}

export function isInQuietHours(settings: AlertSettings['quietHours'], now: Millis): boolean {
  if (!settings.enabled || settings.startMinute === settings.endMinute) return false;
  const m = minuteOfDay(now, settings.utcOffsetMinutes);
  return settings.startMinute < settings.endMinute
    ? m >= settings.startMinute && m < settings.endMinute
    : m >= settings.startMinute || m < settings.endMinute;
}

interface Context {
  readonly input: AlertInput;
  readonly s: AlertSettings;
  readonly wasActive: (kind: AlertKind) => boolean;
  readonly fmt: (mgdl: number) => string;
}

function lowFamily(ctx: Context, kind: 'urgentLow' | 'low', bg: number, date: Millis): Condition | null {
  const cfg = ctx.s[kind];
  const breached = bg <= cfg.threshold || (ctx.wasActive(kind) && bg < cfg.threshold + ctx.s.hysteresisMgdl);
  if (!breached) return null;
  return kind === 'urgentLow'
    ? { severity: 'critical', title: 'Urgent Low Glucose', body: `Glucose ${ctx.fmt(bg)}.`, since: date }
    : { severity: 'warning', title: 'Low Glucose', body: `Glucose ${ctx.fmt(bg)}.`, since: date };
}

function high(ctx: Context, bg: number, date: Millis): Condition | null {
  const cfg = ctx.s.high;
  const breached = bg >= cfg.threshold || (ctx.wasActive('high') && bg > cfg.threshold - ctx.s.hysteresisMgdl);
  return breached ? { severity: 'warning', title: 'High Glucose', body: `Glucose ${ctx.fmt(bg)}.`, since: date } : null;
}

/** Hysteresis: once active, the rate may relax by 1 mg/dL/min before the alert clears. */
const RATE_HYSTERESIS_PER_MIN = 1;

function rate(ctx: Context, kind: 'risingFast' | 'fallingFast', readings: readonly GlucoseReading[], date: Millis): Condition | null {
  const status = glucoseStatus(readings);
  if (!status) return null;
  const sign = kind === 'risingFast' ? 1 : -1;
  const last = (sign * status.delta) / 5;
  const short = (sign * status.shortAvgDelta) / 5;
  const limit = ctx.s[kind].rateMgdlPerMin;
  const breached =
    (last >= limit && short >= limit) || (ctx.wasActive(kind) && short >= limit - RATE_HYSTERESIS_PER_MIN);
  if (!breached) return null;
  const perMin = Math.abs(status.shortAvgDelta / 5).toFixed(1);
  return kind === 'risingFast'
    ? { severity: 'info', title: 'Rising Fast', body: `Glucose ${ctx.fmt(status.glucose)}, rising ${perMin} mg/dL/min.`, since: date }
    : { severity: 'warning', title: 'Falling Fast', body: `Glucose ${ctx.fmt(status.glucose)}, falling ${perMin} mg/dL/min.`, since: date };
}

function predictionCurves(p: Predictions | undefined): (readonly number[])[] {
  if (!p) return [];
  return [p.iob, p.cob, p.uam, p.zt, p.main].filter((c): c is readonly number[] => Array.isArray(c) && c.length > 0);
}

/** Lowest predicted value within `horizonMinutes` after the loop run (index 0 == run time). */
export function forecastMin(predictions: Predictions | undefined, horizonMinutes: number): number | null {
  const lastIndex = Math.floor(horizonMinutes / 5);
  let min: number | null = null;
  for (const curve of predictionCurves(predictions)) {
    for (const v of curve.slice(0, lastIndex + 1)) if (Number.isFinite(v) && (min === null || v < min)) min = v;
  }
  return min;
}

function usableDecision(ctx: Context): AlgorithmDecision | null {
  const run = ctx.input.lastLoopRun;
  if (!run || run.error || ctx.input.now - run.date > ctx.s.maxPredictionAgeMinutes * MINUTE) return null;
  return run.suggested;
}

function forecastLow(ctx: Context): Condition | null {
  const cfg = ctx.s.forecastLow;
  const decision = usableDecision(ctx);
  const min = forecastMin(decision?.predictions, cfg.horizonMinutes);
  if (min === null || !ctx.input.lastLoopRun) return null;
  const breached = min <= cfg.threshold || (ctx.wasActive('forecastLow') && min < cfg.threshold + ctx.s.hysteresisMgdl);
  if (!breached) return null;
  return {
    severity: 'warning',
    title: 'Low Glucose Soon',
    body: `Your glucose may go below ${ctx.fmt(cfg.threshold)} in ${cfg.horizonMinutes} min.`,
    since: ctx.input.lastLoopRun.date,
  };
}

function carbsRequired(ctx: Context): Condition | null {
  const grams = usableDecision(ctx)?.carbsReq;
  if (grams === undefined || grams < ctx.s.carbsRequired.grams || !ctx.input.lastLoopRun) return null;
  return {
    severity: 'warning',
    title: 'Carbs Required',
    body: `To prevent a low, ${Math.round(grams)} g of carbs are required.`,
    since: ctx.input.lastLoopRun.date,
  };
}

function staleData(ctx: Context, newest: GlucoseReading | undefined): Condition | null {
  const limit = ctx.s.staleData.minutes * MINUTE;
  if (!newest) return { severity: 'warning', title: 'No Glucose Data', body: 'No CGM readings available.', since: ctx.input.now };
  const age = ctx.input.now - newest.date;
  if (age < limit) return null;
  return {
    severity: 'warning',
    title: 'Glucose Data Stale',
    body: `No CGM reading for ${Math.floor(age / MINUTE)} min.`,
    since: newest.date + limit,
  };
}

function notLooping(ctx: Context): Condition | null {
  const run = ctx.input.lastLoopRun;
  if (!run) return null;
  const cfg = ctx.s.notLooping;
  const lastOk = ctx.input.lastSuccessfulLoopAt ?? (run.error ? null : run.date) ?? run.date;
  const age = ctx.input.now - lastOk;
  if (age < cfg.minutes * MINUTE) return null;
  const critical = age >= cfg.criticalMinutes * MINUTE;
  const error = run.error ? ` Last error: ${run.error}` : '';
  return {
    severity: critical ? 'critical' : 'warning',
    title: 'Buddy Not Active',
    body: `Last loop was ${Math.floor(age / MINUTE)} min ago.${error}`,
    since: lastOk + cfg.minutes * MINUTE,
  };
}

function reservoir(ctx: Context): Condition | null {
  const units = ctx.input.pump?.reservoirUnits;
  if (units === null || units === undefined || units > ctx.s.pumpReservoirLow.units) return null;
  return {
    severity: units <= 0 ? 'critical' : 'warning',
    title: units <= 0 ? 'Reservoir Empty' : 'Reservoir Low',
    body: `${units.toFixed(1)} U remaining.`,
    since: ctx.input.now,
  };
}

function battery(ctx: Context): Condition | null {
  const pct = ctx.input.pump?.batteryPercent;
  if (pct === null || pct === undefined || pct > ctx.s.pumpBatteryLow.percent) return null;
  return { severity: 'warning', title: 'Pump Battery Low', body: `Battery at ${Math.round(pct)}%.`, since: ctx.input.now };
}

function detectConditions(ctx: Context): Map<AlertKind, Condition> {
  const s = ctx.s;
  const readings = [...ctx.input.glucose].filter((r) => r.value > 38).sort((a, b) => b.date - a.date);
  const newest = readings[0];
  const fresh = newest && ctx.input.now - newest.date <= s.maxReadingAgeMinutes * MINUTE ? newest : undefined;
  const found = new Map<AlertKind, Condition | null>();
  const check = (kind: AlertKind, fn: () => Condition | null) => {
    if (s[kind].enabled) found.set(kind, fn());
  };
  // Urgent low is the safety floor and cannot be disabled (as in Trio).
  if (fresh) found.set('urgentLow', lowFamily(ctx, 'urgentLow', fresh.value, fresh.date));
  if (fresh) check('low', () => lowFamily(ctx, 'low', fresh.value, fresh.date));
  if (fresh) check('high', () => high(ctx, fresh.value, fresh.date));
  if (fresh) check('risingFast', () => rate(ctx, 'risingFast', readings, fresh.date));
  if (fresh) check('fallingFast', () => rate(ctx, 'fallingFast', readings, fresh.date));
  check('forecastLow', () => forecastLow(ctx));
  check('carbsRequired', () => carbsRequired(ctx));
  check('staleData', () => staleData(ctx, newest));
  check('notLooping', () => notLooping(ctx));
  check('pumpReservoirLow', () => reservoir(ctx));
  check('pumpBatteryLow', () => battery(ctx));

  // Higher-priority low-family alerts supersede lower ones (Trio: forecast came true).
  if (found.get('urgentLow')) found.delete('low');
  if (found.get('urgentLow') || found.get('low')) found.delete('forecastLow');

  const out = new Map<AlertKind, Condition>();
  for (const kind of ALERT_KINDS) {
    const c = found.get(kind);
    if (c) out.set(kind, c);
  }
  return out;
}

export function evaluateAlerts(input: AlertInput): AlertResult {
  const s = input.settings;
  const previous = new Map(input.previouslyActive.map((a) => [a.kind, a] as const));
  const ctx: Context = {
    input,
    s,
    wasActive: (kind) => previous.has(kind),
    fmt: (mgdl) => `${formatGlucose(mgdl, s.unit)} ${s.unit}`,
  };
  const quiet = isInQuietHours(s.quietHours, input.now);
  const active: Alert[] = [];
  const toNotify: Alert[] = [];

  for (const [kind, c] of detectConditions(ctx)) {
    const prev = previous.get(kind);
    const repeatMs = s[kind].repeatMinutes * MINUTE;
    const escalated = prev !== undefined && SEVERITY_RANK[c.severity] > SEVERITY_RANK[prev.severity];
    const due =
      prev === undefined ||
      prev.lastNotifiedAt === null ||
      escalated ||
      (repeatMs > 0 && input.now - prev.lastNotifiedAt >= repeatMs);
    const suppressed = isSnoozed(input.snoozes, kind, input.now) || (quiet && kind !== 'urgentLow');
    const notify = due && !suppressed;
    const alert: Alert = {
      kind,
      severity: c.severity,
      title: c.title,
      body: c.body,
      since: prev?.since ?? c.since,
      lastNotifiedAt: notify ? input.now : (prev?.lastNotifiedAt ?? null),
    };
    active.push(alert);
    if (notify) toNotify.push(alert);
  }
  return { active, toNotify };
}
