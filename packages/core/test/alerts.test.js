import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_SETTINGS, evaluateAlerts, forecastMin, isInQuietHours, isSnoozed, snoozeAlert, MINUTE, } from '../src';
import { pumpState, series, T0 } from './fixtures';
const loopRun = (over = {}) => {
    const { predictions, carbsReq, ...rest } = over;
    return {
        date: T0,
        mode: 'closed',
        algorithmId: 'test',
        glucose: 120,
        iob: 0,
        cob: 0,
        suggested: { reason: 'test', predictions, carbsReq },
        guarded: null,
        interventions: [],
        enacted: null,
        durationMs: 1,
        ...rest,
    };
};
const settingsWith = (over) => {
    const out = { ...DEFAULT_ALERT_SETTINGS };
    for (const [k, v] of Object.entries(over)) {
        const base = DEFAULT_ALERT_SETTINGS[k];
        out[k] = typeof base === 'object' ? { ...base, ...v } : v;
    }
    return out;
};
const input = (over = {}) => {
    const { bg, slope, ...rest } = over;
    const now = rest.now ?? T0;
    return {
        now,
        glucose: series(now, bg ?? 120, slope ?? 0),
        lastLoopRun: loopRun({ date: now }),
        pump: pumpState(),
        settings: DEFAULT_ALERT_SETTINGS,
        snoozes: {},
        previouslyActive: [],
        ...rest,
    };
};
const kinds = (alerts) => alerts.map((a) => a.kind);
/** Evaluates a sequence of steps, feeding `active` forward like the app does. */
function run(steps) {
    let previouslyActive = [];
    return steps.map((step) => {
        const result = evaluateAlerts(input({ previouslyActive, ...step }));
        previouslyActive = result.active;
        return result;
    });
}
describe('defaults', () => {
    it('mirrors Trio thresholds', () => {
        expect(DEFAULT_ALERT_SETTINGS.urgentLow.threshold).toBe(54);
        expect(DEFAULT_ALERT_SETTINGS.low.threshold).toBe(72);
        expect(DEFAULT_ALERT_SETTINGS.forecastLow).toMatchObject({ threshold: 72, horizonMinutes: 20 });
        expect(DEFAULT_ALERT_SETTINGS.high.threshold).toBe(270);
        expect(DEFAULT_ALERT_SETTINGS.notLooping).toMatchObject({ minutes: 20, criticalMinutes: 120 });
        expect(DEFAULT_ALERT_SETTINGS.hysteresisMgdl).toBe(5);
    });
    it('raises nothing for an in-range, fresh, looping state', () => {
        expect(evaluateAlerts(input())).toEqual({ active: [], toNotify: [] });
    });
});
describe('glucose thresholds', () => {
    it('fires urgent low at the threshold as critical and supersedes low', () => {
        const r = evaluateAlerts(input({ bg: 54 }));
        expect(kinds(r.active)).toEqual(['urgentLow']);
        expect(r.active[0]).toMatchObject({ severity: 'critical', title: 'Urgent Low Glucose', body: 'Glucose 54 mg/dL.', since: T0 });
        expect(kinds(r.toNotify)).toEqual(['urgentLow']);
    });
    it('fires low (not urgent) just above the urgent threshold', () => {
        const r = evaluateAlerts(input({ bg: 55 }));
        expect(kinds(r.active)).toEqual(['low']);
        expect(r.active[0].severity).toBe('warning');
    });
    it('fires low at exactly 72 but not at 73', () => {
        expect(kinds(evaluateAlerts(input({ bg: 72 })).active)).toEqual(['low']);
        expect(evaluateAlerts(input({ bg: 73 })).active).toEqual([]);
    });
    it('fires high at 270 but not 269', () => {
        expect(kinds(evaluateAlerts(input({ bg: 270 })).active)).toEqual(['high']);
        expect(evaluateAlerts(input({ bg: 269 })).active).toEqual([]);
    });
    it('respects disabled kinds but never disables urgent low', () => {
        const settings = settingsWith({ low: { enabled: false }, urgentLow: { enabled: false } });
        expect(evaluateAlerts(input({ bg: 60, settings })).active).toEqual([]);
        expect(kinds(evaluateAlerts(input({ bg: 50, settings })).active)).toEqual(['urgentLow']);
    });
    it('formats values in mmol/L when configured', () => {
        const r = evaluateAlerts(input({ bg: 54, settings: settingsWith({ unit: 'mmol/L' }) }));
        expect(r.active[0].body).toBe('Glucose 3.0 mmol/L.');
    });
    it('ignores glucose older than maxReadingAgeMinutes for glucose alerts', () => {
        const r = evaluateAlerts(input({ now: T0 + 13 * MINUTE, glucose: series(T0, 50, 0), lastLoopRun: loopRun({ date: T0 + 13 * MINUTE }) }));
        expect(r.active).toEqual([]);
    });
    it('ignores sensor error values (<= 38)', () => {
        const glucose = [{ date: T0, value: 38, source: 'test' }, ...series(T0 - 5 * MINUTE, 120, 0, 3)];
        expect(evaluateAlerts(input({ glucose })).active).toEqual([]);
    });
    it('accepts readings in any order', () => {
        const glucose = [...series(T0, 50, -2)].reverse();
        expect(kinds(evaluateAlerts(input({ glucose })).active)).toEqual(['urgentLow']);
    });
});
describe('hysteresis', () => {
    it('keeps low active until glucose reaches threshold + 5', () => {
        const [a, b, c, d] = run([
            { now: T0, bg: 70 },
            { now: T0 + 5 * MINUTE, bg: 74 },
            { now: T0 + 10 * MINUTE, bg: 76 },
            { now: T0 + 15 * MINUTE, bg: 77 },
        ]);
        expect(kinds(a.active)).toEqual(['low']);
        expect(kinds(b.active)).toEqual(['low']);
        expect(kinds(c.active)).toEqual(['low']);
        expect(d.active).toEqual([]);
    });
    it('does not re-notify while flapping inside the band', () => {
        const results = run([
            { now: T0, bg: 72 },
            { now: T0 + 5 * MINUTE, bg: 73 },
            { now: T0 + 10 * MINUTE, bg: 71 },
            { now: T0 + 14 * MINUTE, bg: 74 },
        ]);
        expect(results.map((r) => r.toNotify.length)).toEqual([1, 0, 0, 0]);
    });
    it('keeps high active until glucose falls to threshold - 5', () => {
        const [a, b, c] = run([
            { now: T0, bg: 270 },
            { now: T0 + 5 * MINUTE, bg: 266 },
            { now: T0 + 10 * MINUTE, bg: 265 },
        ]);
        expect(kinds(a.active)).toEqual(['high']);
        expect(kinds(b.active)).toEqual(['high']);
        expect(c.active).toEqual([]);
    });
    it('keeps `since` stable while the alert stays active', () => {
        const [, b] = run([{ now: T0, bg: 280 }, { now: T0 + 5 * MINUTE, bg: 290 }]);
        expect(b.active[0].since).toBe(T0);
        expect(b.active[0].body).toBe('Glucose 290 mg/dL.');
    });
});
describe('repeat intervals', () => {
    it('re-notifies low after 15 minutes, not before', () => {
        const results = run([
            { now: T0, bg: 65 },
            { now: T0 + 10 * MINUTE, bg: 65 },
            { now: T0 + 15 * MINUTE, bg: 65 },
            { now: T0 + 20 * MINUTE, bg: 65 },
        ]);
        expect(results.map((r) => kinds(r.toNotify))).toEqual([['low'], [], ['low'], []]);
        expect(results[2].active[0].lastNotifiedAt).toBe(T0 + 15 * MINUTE);
        expect(results[3].active[0].lastNotifiedAt).toBe(T0 + 15 * MINUTE);
    });
    it('re-notifies urgent low every 5 minutes', () => {
        const results = run([0, 5, 10].map((m) => ({ now: T0 + m * MINUTE, bg: 50 })));
        expect(results.map((r) => r.toNotify.length)).toEqual([1, 1, 1]);
    });
    it('notifies only once with repeatMinutes 0', () => {
        const settings = settingsWith({ low: { repeatMinutes: 0 } });
        const results = run([0, 30, 60].map((m) => ({ now: T0 + m * MINUTE, bg: 65, settings })));
        expect(results.map((r) => r.toNotify.length)).toEqual([1, 0, 0]);
    });
    it('notifies again after an alert cleared and re-triggered', () => {
        const results = run([
            { now: T0, bg: 65 },
            { now: T0 + 5 * MINUTE, bg: 90 },
            { now: T0 + 10 * MINUTE, bg: 65 },
        ]);
        expect(results.map((r) => r.toNotify.length)).toEqual([1, 0, 1]);
        expect(results[2].active[0].since).toBe(T0 + 10 * MINUTE);
    });
});
describe('snoozes', () => {
    it('suppresses notification but keeps the alert active', () => {
        const r = evaluateAlerts(input({ bg: 65, snoozes: { low: T0 + 30 * MINUTE } }));
        expect(kinds(r.active)).toEqual(['low']);
        expect(r.toNotify).toEqual([]);
        expect(r.active[0].lastNotifiedAt).toBeNull();
    });
    it('notifies once the snooze expires', () => {
        const snoozes = { low: T0 + 30 * MINUTE };
        const results = run([
            { now: T0, bg: 65, snoozes },
            { now: T0 + 25 * MINUTE, bg: 65, snoozes },
            { now: T0 + 30 * MINUTE, bg: 65, snoozes },
        ]);
        expect(results.map((r) => r.toNotify.length)).toEqual([0, 0, 1]);
    });
    it('is per kind', () => {
        const r = evaluateAlerts(input({ bg: 300, snoozes: { low: T0 + HOUR_MS } }));
        expect(kinds(r.toNotify)).toEqual(['high']);
    });
    it('caps an urgent-low snooze at 15 minutes', () => {
        const s = snoozeAlert({}, 'urgentLow', T0 + 60 * MINUTE, T0);
        expect(s.urgentLow).toBe(T0 + 15 * MINUTE);
        expect(snoozeAlert({}, 'urgentLow', T0 + 10 * MINUTE, T0).urgentLow).toBe(T0 + 10 * MINUTE);
        expect(snoozeAlert({}, 'low', T0 + 60 * MINUTE, T0).low).toBe(T0 + 60 * MINUTE);
    });
    it('snoozeAlert does not mutate the input map', () => {
        const before = { high: T0 + MINUTE };
        const after = snoozeAlert(before, 'low', T0 + 5 * MINUTE, T0);
        expect(before).toEqual({ high: T0 + MINUTE });
        expect(after).toEqual({ high: T0 + MINUTE, low: T0 + 5 * MINUTE });
    });
    it('honours a valid urgent-low snooze', () => {
        const r = evaluateAlerts(input({ bg: 50, snoozes: { urgentLow: T0 + 15 * MINUTE } }));
        expect(kinds(r.active)).toEqual(['urgentLow']);
        expect(r.toNotify).toEqual([]);
    });
    it('ignores an urgent-low snooze longer than 15 minutes (fail safe)', () => {
        expect(isSnoozed({ urgentLow: T0 + 16 * MINUTE }, 'urgentLow', T0)).toBe(false);
        const r = evaluateAlerts(input({ bg: 50, snoozes: { urgentLow: T0 + 60 * MINUTE } }));
        expect(kinds(r.toNotify)).toEqual(['urgentLow']);
    });
    it('treats an expired snooze as not snoozed', () => {
        expect(isSnoozed({ low: T0 }, 'low', T0)).toBe(false);
        expect(isSnoozed({ low: T0 + 1 }, 'low', T0)).toBe(true);
    });
});
const HOUR_MS = 60 * MINUTE;
const MIDNIGHT = Date.UTC(2026, 0, 1);
describe('quiet hours', () => {
    const quiet = (over = {}) => settingsWith({ quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 6 * 60, ...over } });
    it('detects a window that wraps midnight', () => {
        const q = quiet().quietHours;
        expect(isInQuietHours(q, MIDNIGHT + 23 * HOUR_MS)).toBe(true);
        expect(isInQuietHours(q, MIDNIGHT + 2 * HOUR_MS)).toBe(true);
        expect(isInQuietHours(q, MIDNIGHT + 6 * HOUR_MS)).toBe(false);
        expect(isInQuietHours(q, MIDNIGHT + 21 * HOUR_MS + 59 * MINUTE)).toBe(false);
    });
    it('detects a same-day window', () => {
        const q = quiet({ startMinute: 13 * 60, endMinute: 14 * 60 }).quietHours;
        expect(isInQuietHours(q, MIDNIGHT + 13 * HOUR_MS + 30 * MINUTE)).toBe(true);
        expect(isInQuietHours(q, MIDNIGHT + 14 * HOUR_MS)).toBe(false);
    });
    it('applies the UTC offset', () => {
        const q = quiet({ utcOffsetMinutes: 60 }).quietHours;
        // 21:30 UTC == 22:30 local
        expect(isInQuietHours(q, MIDNIGHT + 21 * HOUR_MS + 30 * MINUTE)).toBe(true);
        expect(isInQuietHours({ ...q, enabled: false }, MIDNIGHT + 23 * HOUR_MS)).toBe(false);
    });
    it('silences non-urgent alerts but not urgent low', () => {
        const now = MIDNIGHT + 23 * HOUR_MS;
        const settings = quiet();
        const low = evaluateAlerts(input({ now, bg: 65, settings, lastLoopRun: loopRun({ date: now }) }));
        expect(kinds(low.active)).toEqual(['low']);
        expect(low.toNotify).toEqual([]);
        const urgent = evaluateAlerts(input({ now, bg: 50, settings, lastLoopRun: loopRun({ date: now }) }));
        expect(kinds(urgent.toNotify)).toEqual(['urgentLow']);
    });
    it('notifies a still-active alert once quiet hours end', () => {
        const settings = quiet();
        const at = (m) => MIDNIGHT + 5 * HOUR_MS + 55 * MINUTE + m * MINUTE;
        const results = run([0, 5].map((m) => ({ now: at(m), bg: 300, settings, lastLoopRun: loopRun({ date: at(m) }) })));
        expect(results.map((r) => r.toNotify.length)).toEqual([0, 1]);
    });
});
describe('staleData', () => {
    it('fires once the newest reading is 20 min old', () => {
        const glucose = series(T0, 120, 0);
        const at = (m) => evaluateAlerts(input({ now: T0 + m * MINUTE, glucose, lastLoopRun: loopRun({ date: T0 + m * MINUTE }) }));
        expect(at(19).active).toEqual([]);
        const r = at(20);
        expect(kinds(r.active)).toEqual(['staleData']);
        expect(r.active[0]).toMatchObject({ title: 'Glucose Data Stale', body: 'No CGM reading for 20 min.', since: T0 + 20 * MINUTE });
    });
    it('fires when there is no glucose at all', () => {
        const r = evaluateAlerts(input({ glucose: [] }));
        expect(kinds(r.active)).toEqual(['staleData']);
        expect(r.active[0].title).toBe('No Glucose Data');
    });
    it('repeats every 30 minutes', () => {
        const glucose = series(T0, 120, 0);
        const results = run([20, 40, 50].map((m) => ({ now: T0 + m * MINUTE, glucose, lastLoopRun: loopRun({ date: T0 + m * MINUTE }) })));
        expect(results.map((r) => r.toNotify.length)).toEqual([1, 0, 1]);
    });
});
describe('notLooping', () => {
    const at = (m, over = {}) => input({ now: T0 + m * MINUTE, glucose: series(T0 + m * MINUTE, 120, 0), lastLoopRun: loopRun({ date: T0 }), ...over });
    it('fires a warning after 20 minutes', () => {
        expect(evaluateAlerts(at(19)).active).toEqual([]);
        const r = evaluateAlerts(at(20));
        expect(r.active[0]).toMatchObject({
            kind: 'notLooping',
            severity: 'warning',
            title: 'Buddy Not Active',
            body: 'Last loop was 20 min ago.',
            since: T0 + 20 * MINUTE,
        });
    });
    it('escalates to critical after 120 minutes and notifies on escalation', () => {
        const results = run([110, 120].map((m) => at(m)));
        expect(results[0].active[0].severity).toBe('warning');
        expect(results[1].active[0].severity).toBe('critical');
        // 10 min after the last notification (repeat 20) but escalated -> notify
        expect(kinds(results[1].toNotify)).toEqual(['notLooping']);
    });
    it('is silent before the loop ever ran', () => {
        expect(evaluateAlerts(at(300, { lastLoopRun: null })).active).toEqual([]);
    });
    it('uses lastSuccessfulLoopAt when the latest run failed', () => {
        const failing = loopRun({ date: T0 + 25 * MINUTE, error: 'Pump unreachable' });
        const r = evaluateAlerts(at(25, { lastLoopRun: failing, lastSuccessfulLoopAt: T0 }));
        expect(r.active[0]).toMatchObject({ kind: 'notLooping', body: 'Last loop was 25 min ago. Last error: Pump unreachable' });
        expect(evaluateAlerts(at(25, { lastLoopRun: failing })).active).toEqual([]);
    });
});
describe('forecastLow', () => {
    const withPred = (predictions, over = {}) => input({ lastLoopRun: loopRun({ predictions }), ...over });
    it('fires when any curve dips to the threshold within 20 minutes', () => {
        const r = evaluateAlerts(withPred({ iob: [120, 110, 100], uam: [120, 100, 90, 80, 72, 70] }));
        expect(kinds(r.active)).toEqual(['forecastLow']);
        expect(r.active[0]).toMatchObject({ title: 'Low Glucose Soon', body: 'Your glucose may go below 72 mg/dL in 20 min.' });
    });
    it('ignores dips beyond the horizon', () => {
        // index 4 == 20 min (100), index 5 == 25 min (60)
        expect(evaluateAlerts(withPred({ main: [120, 115, 110, 105, 100, 60] })).active).toEqual([]);
    });
    it('respects a custom horizon', () => {
        const settings = settingsWith({ forecastLow: { horizonMinutes: 30 } });
        expect(kinds(evaluateAlerts(withPred({ main: [120, 115, 110, 105, 100, 60] }, { settings })).active)).toEqual(['forecastLow']);
    });
    it('ignores predictions from an old or failed loop run', () => {
        const predictions = { zt: [100, 80, 60] };
        expect(evaluateAlerts(input({ now: T0 + 16 * MINUTE, glucose: series(T0 + 16 * MINUTE, 120, 0), lastLoopRun: loopRun({ predictions }) })).active).toEqual([]);
        expect(evaluateAlerts(input({ lastLoopRun: loopRun({ predictions, error: 'x' }) })).active).toEqual([]);
    });
    it('is superseded by an actual low', () => {
        const r = evaluateAlerts(withPred({ main: [65, 60, 55] }, { bg: 65 }));
        expect(kinds(r.active)).toEqual(['low']);
    });
    it('has hysteresis on the forecast minimum', () => {
        const results = run([
            { lastLoopRun: loopRun({ predictions: { main: [100, 72] } }) },
            { lastLoopRun: loopRun({ predictions: { main: [100, 76] } }) },
            { lastLoopRun: loopRun({ predictions: { main: [100, 77] } }) },
        ]);
        expect(results.map((r) => kinds(r.active))).toEqual([['forecastLow'], ['forecastLow'], []]);
    });
    it('forecastMin handles missing and non-finite values', () => {
        expect(forecastMin(undefined, 20)).toBeNull();
        expect(forecastMin({ main: [] }, 20)).toBeNull();
        expect(forecastMin({ main: [100, Number.NaN, 90], cob: [95] }, 20)).toBe(90);
    });
});
describe('rate alerts', () => {
    const enabled = settingsWith({ risingFast: { enabled: true }, fallingFast: { enabled: true } });
    it('are off by default', () => {
        expect(evaluateAlerts(input({ bg: 200, slope: 20 })).active).toEqual([]);
    });
    it('fires risingFast at >= 3 mg/dL/min', () => {
        const r = evaluateAlerts(input({ bg: 200, slope: 15, settings: enabled }));
        expect(r.active[0]).toMatchObject({ kind: 'risingFast', severity: 'info', body: 'Glucose 200 mg/dL, rising 3.0 mg/dL/min.' });
        expect(evaluateAlerts(input({ bg: 200, slope: 14, settings: enabled })).active).toEqual([]);
    });
    it('fires fallingFast at <= -3 mg/dL/min', () => {
        const r = evaluateAlerts(input({ bg: 150, slope: -20, settings: enabled }));
        expect(r.active[0]).toMatchObject({ kind: 'fallingFast', severity: 'warning', body: 'Glucose 150 mg/dL, falling 4.0 mg/dL/min.' });
    });
    it('stays active until the rate relaxes by more than 1 mg/dL/min', () => {
        const results = run([
            { bg: 150, slope: -15, settings: enabled },
            { bg: 150, slope: -10, settings: enabled },
            { bg: 150, slope: -9, settings: enabled },
        ]);
        expect(results.map((r) => kinds(r.active))).toEqual([['fallingFast'], ['fallingFast'], []]);
    });
});
describe('pump and carbs alerts', () => {
    it('fires reservoir low at 20 U and critical when empty', () => {
        expect(evaluateAlerts(input({ pump: pumpState({ reservoirUnits: 21 }) })).active).toEqual([]);
        expect(evaluateAlerts(input({ pump: pumpState({ reservoirUnits: 20 }) })).active[0]).toMatchObject({
            kind: 'pumpReservoirLow',
            severity: 'warning',
            body: '20.0 U remaining.',
        });
        expect(evaluateAlerts(input({ pump: pumpState({ reservoirUnits: 0 }) })).active[0]).toMatchObject({ severity: 'critical', title: 'Reservoir Empty' });
    });
    it('fires battery low at 20 %', () => {
        expect(kinds(evaluateAlerts(input({ pump: pumpState({ batteryPercent: 20 }) })).active)).toEqual(['pumpBatteryLow']);
        expect(evaluateAlerts(input({ pump: pumpState({ batteryPercent: 21 }) })).active).toEqual([]);
    });
    it('ignores unknown pump values and a missing pump', () => {
        expect(evaluateAlerts(input({ pump: pumpState({ reservoirUnits: null, batteryPercent: null }) })).active).toEqual([]);
        expect(evaluateAlerts(input({ pump: null })).active).toEqual([]);
    });
    it('fires carbsRequired from the loop decision', () => {
        expect(evaluateAlerts(input({ lastLoopRun: loopRun({ carbsReq: 9 }) })).active).toEqual([]);
        expect(evaluateAlerts(input({ lastLoopRun: loopRun({ carbsReq: 14.6 }) })).active[0]).toMatchObject({
            kind: 'carbsRequired',
            body: 'To prevent a low, 15 g of carbs are required.',
        });
    });
});
describe('ordering', () => {
    it('lists active alerts by priority', () => {
        const r = evaluateAlerts(input({ bg: 50, pump: pumpState({ reservoirUnits: 5, batteryPercent: 5 }), lastLoopRun: loopRun({ date: T0 - 30 * MINUTE }) }));
        expect(kinds(r.active)).toEqual(['urgentLow', 'notLooping', 'pumpReservoirLow', 'pumpBatteryLow']);
    });
});
