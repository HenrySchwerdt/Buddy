import { glucoseStatus } from './glucose';
import { minuteOfDay } from './schedule';
import { formatGlucose, MINUTE } from './units';
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
];
/** Maximum snooze for urgent low (Trio's quick-snooze safety floor). */
export const URGENT_LOW_MAX_SNOOZE_MINUTES = 15;
export const DEFAULT_ALERT_SETTINGS = {
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
const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
/** Returns a new snooze map; urgent low is capped at 15 minutes from `now`. */
export function snoozeAlert(snoozes, kind, until, now) {
    const capped = kind === 'urgentLow' ? Math.min(until, now + URGENT_LOW_MAX_SNOOZE_MINUTES * MINUTE) : until;
    return { ...snoozes, [kind]: capped };
}
/** An urgent-low snooze reaching further than the cap is ignored entirely (fail safe). */
export function isSnoozed(snoozes, kind, now) {
    const until = snoozes[kind];
    if (until === undefined || until <= now)
        return false;
    if (kind === 'urgentLow' && until > now + URGENT_LOW_MAX_SNOOZE_MINUTES * MINUTE)
        return false;
    return true;
}
export function isInQuietHours(settings, now) {
    if (!settings.enabled || settings.startMinute === settings.endMinute)
        return false;
    const m = minuteOfDay(now, settings.utcOffsetMinutes);
    return settings.startMinute < settings.endMinute
        ? m >= settings.startMinute && m < settings.endMinute
        : m >= settings.startMinute || m < settings.endMinute;
}
function lowFamily(ctx, kind, bg, date) {
    const cfg = ctx.s[kind];
    const breached = bg <= cfg.threshold || (ctx.wasActive(kind) && bg < cfg.threshold + ctx.s.hysteresisMgdl);
    if (!breached)
        return null;
    return kind === 'urgentLow'
        ? { severity: 'critical', title: 'Urgent Low Glucose', body: `Glucose ${ctx.fmt(bg)}.`, since: date }
        : { severity: 'warning', title: 'Low Glucose', body: `Glucose ${ctx.fmt(bg)}.`, since: date };
}
function high(ctx, bg, date) {
    const cfg = ctx.s.high;
    const breached = bg >= cfg.threshold || (ctx.wasActive('high') && bg > cfg.threshold - ctx.s.hysteresisMgdl);
    return breached ? { severity: 'warning', title: 'High Glucose', body: `Glucose ${ctx.fmt(bg)}.`, since: date } : null;
}
/** Hysteresis: once active, the rate may relax by 1 mg/dL/min before the alert clears. */
const RATE_HYSTERESIS_PER_MIN = 1;
function rate(ctx, kind, readings, date) {
    const status = glucoseStatus(readings);
    if (!status)
        return null;
    const sign = kind === 'risingFast' ? 1 : -1;
    const last = (sign * status.delta) / 5;
    const short = (sign * status.shortAvgDelta) / 5;
    const limit = ctx.s[kind].rateMgdlPerMin;
    const breached = (last >= limit && short >= limit) || (ctx.wasActive(kind) && short >= limit - RATE_HYSTERESIS_PER_MIN);
    if (!breached)
        return null;
    const perMin = Math.abs(status.shortAvgDelta / 5).toFixed(1);
    return kind === 'risingFast'
        ? { severity: 'info', title: 'Rising Fast', body: `Glucose ${ctx.fmt(status.glucose)}, rising ${perMin} mg/dL/min.`, since: date }
        : { severity: 'warning', title: 'Falling Fast', body: `Glucose ${ctx.fmt(status.glucose)}, falling ${perMin} mg/dL/min.`, since: date };
}
function predictionCurves(p) {
    if (!p)
        return [];
    return [p.iob, p.cob, p.uam, p.zt, p.main].filter((c) => Array.isArray(c) && c.length > 0);
}
/** Lowest predicted value within `horizonMinutes` after the loop run (index 0 == run time). */
export function forecastMin(predictions, horizonMinutes) {
    const lastIndex = Math.floor(horizonMinutes / 5);
    let min = null;
    for (const curve of predictionCurves(predictions)) {
        for (const v of curve.slice(0, lastIndex + 1))
            if (Number.isFinite(v) && (min === null || v < min))
                min = v;
    }
    return min;
}
function usableDecision(ctx) {
    const run = ctx.input.lastLoopRun;
    if (!run || run.error || ctx.input.now - run.date > ctx.s.maxPredictionAgeMinutes * MINUTE)
        return null;
    return run.suggested;
}
function forecastLow(ctx) {
    const cfg = ctx.s.forecastLow;
    const decision = usableDecision(ctx);
    const min = forecastMin(decision?.predictions, cfg.horizonMinutes);
    if (min === null || !ctx.input.lastLoopRun)
        return null;
    const breached = min <= cfg.threshold || (ctx.wasActive('forecastLow') && min < cfg.threshold + ctx.s.hysteresisMgdl);
    if (!breached)
        return null;
    return {
        severity: 'warning',
        title: 'Low Glucose Soon',
        body: `Your glucose may go below ${ctx.fmt(cfg.threshold)} in ${cfg.horizonMinutes} min.`,
        since: ctx.input.lastLoopRun.date,
    };
}
function carbsRequired(ctx) {
    const grams = usableDecision(ctx)?.carbsReq;
    if (grams === undefined || grams < ctx.s.carbsRequired.grams || !ctx.input.lastLoopRun)
        return null;
    return {
        severity: 'warning',
        title: 'Carbs Required',
        body: `To prevent a low, ${Math.round(grams)} g of carbs are required.`,
        since: ctx.input.lastLoopRun.date,
    };
}
function staleData(ctx, newest) {
    const limit = ctx.s.staleData.minutes * MINUTE;
    if (!newest)
        return { severity: 'warning', title: 'No Glucose Data', body: 'No CGM readings available.', since: ctx.input.now };
    const age = ctx.input.now - newest.date;
    if (age < limit)
        return null;
    return {
        severity: 'warning',
        title: 'Glucose Data Stale',
        body: `No CGM reading for ${Math.floor(age / MINUTE)} min.`,
        since: newest.date + limit,
    };
}
function notLooping(ctx) {
    const run = ctx.input.lastLoopRun;
    if (!run)
        return null;
    const cfg = ctx.s.notLooping;
    const lastOk = ctx.input.lastSuccessfulLoopAt ?? (run.error ? null : run.date) ?? run.date;
    const age = ctx.input.now - lastOk;
    if (age < cfg.minutes * MINUTE)
        return null;
    const critical = age >= cfg.criticalMinutes * MINUTE;
    const error = run.error ? ` Last error: ${run.error}` : '';
    return {
        severity: critical ? 'critical' : 'warning',
        title: 'Buddy Not Active',
        body: `Last loop was ${Math.floor(age / MINUTE)} min ago.${error}`,
        since: lastOk + cfg.minutes * MINUTE,
    };
}
function reservoir(ctx) {
    const units = ctx.input.pump?.reservoirUnits;
    if (units === null || units === undefined || units > ctx.s.pumpReservoirLow.units)
        return null;
    return {
        severity: units <= 0 ? 'critical' : 'warning',
        title: units <= 0 ? 'Reservoir Empty' : 'Reservoir Low',
        body: `${units.toFixed(1)} U remaining.`,
        since: ctx.input.now,
    };
}
function battery(ctx) {
    const pct = ctx.input.pump?.batteryPercent;
    if (pct === null || pct === undefined || pct > ctx.s.pumpBatteryLow.percent)
        return null;
    return { severity: 'warning', title: 'Pump Battery Low', body: `Battery at ${Math.round(pct)}%.`, since: ctx.input.now };
}
function detectConditions(ctx) {
    const s = ctx.s;
    const readings = [...ctx.input.glucose].filter((r) => r.value > 38).sort((a, b) => b.date - a.date);
    const newest = readings[0];
    const fresh = newest && ctx.input.now - newest.date <= s.maxReadingAgeMinutes * MINUTE ? newest : undefined;
    const found = new Map();
    const check = (kind, fn) => {
        if (s[kind].enabled)
            found.set(kind, fn());
    };
    // Urgent low is the safety floor and cannot be disabled (as in Trio).
    if (fresh)
        found.set('urgentLow', lowFamily(ctx, 'urgentLow', fresh.value, fresh.date));
    if (fresh)
        check('low', () => lowFamily(ctx, 'low', fresh.value, fresh.date));
    if (fresh)
        check('high', () => high(ctx, fresh.value, fresh.date));
    if (fresh)
        check('risingFast', () => rate(ctx, 'risingFast', readings, fresh.date));
    if (fresh)
        check('fallingFast', () => rate(ctx, 'fallingFast', readings, fresh.date));
    check('forecastLow', () => forecastLow(ctx));
    check('carbsRequired', () => carbsRequired(ctx));
    check('staleData', () => staleData(ctx, newest));
    check('notLooping', () => notLooping(ctx));
    check('pumpReservoirLow', () => reservoir(ctx));
    check('pumpBatteryLow', () => battery(ctx));
    // Higher-priority low-family alerts supersede lower ones (Trio: forecast came true).
    if (found.get('urgentLow'))
        found.delete('low');
    if (found.get('urgentLow') || found.get('low'))
        found.delete('forecastLow');
    const out = new Map();
    for (const kind of ALERT_KINDS) {
        const c = found.get(kind);
        if (c)
            out.set(kind, c);
    }
    return out;
}
export function evaluateAlerts(input) {
    const s = input.settings;
    const previous = new Map(input.previouslyActive.map((a) => [a.kind, a]));
    const ctx = {
        input,
        s,
        wasActive: (kind) => previous.has(kind),
        fmt: (mgdl) => `${formatGlucose(mgdl, s.unit)} ${s.unit}`,
    };
    const quiet = isInQuietHours(s.quietHours, input.now);
    const active = [];
    const toNotify = [];
    for (const [kind, c] of detectConditions(ctx)) {
        const prev = previous.get(kind);
        const repeatMs = s[kind].repeatMinutes * MINUTE;
        const escalated = prev !== undefined && SEVERITY_RANK[c.severity] > SEVERITY_RANK[prev.severity];
        const due = prev === undefined ||
            prev.lastNotifiedAt === null ||
            escalated ||
            (repeatMs > 0 && input.now - prev.lastNotifiedAt >= repeatMs);
        const suppressed = isSnoozed(input.snoozes, kind, input.now) || (quiet && kind !== 'urgentLow');
        const notify = due && !suppressed;
        const alert = {
            kind,
            severity: c.severity,
            title: c.title,
            body: c.body,
            since: prev?.since ?? c.since,
            lastNotifiedAt: notify ? input.now : (prev?.lastNotifiedAt ?? null),
        };
        active.push(alert);
        if (notify)
            toNotify.push(alert);
    }
    return { active, toNotify };
}
