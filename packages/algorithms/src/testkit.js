import { DEFAULT_LIMITS, glucoseStatus, scheduleValueAt, constantSchedule, MINUTE, } from '@buddy/core';
/**
 * Scenario snapshots for algorithm conformance tests. Every algorithm, built-in or new,
 * must behave sensibly on these. Use `conformanceCases` in your own test file.
 */
export const TEST_NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
export const TEST_PROFILE = {
    basal: constantSchedule(1),
    isf: constantSchedule(50),
    carbRatio: constantSchedule(10),
    target: constantSchedule({ low: 100, high: 110 }),
    diaHours: 6,
    insulinCurve: 'rapid-acting',
};
export function readings(last, slopePer5, count = 48) {
    return Array.from({ length: count }, (_, i) => ({ date: TEST_NOW - i * 5 * MINUTE, value: Math.max(40, last - i * slopePer5), source: 'test' }));
}
export function snapshot(over) {
    const glucose = readings(over.bg, over.slope);
    const iob = over.iob ?? 0;
    return {
        now: TEST_NOW,
        glucose,
        glucoseStatus: glucoseStatus(glucose),
        doses: iob > 0 ? [{ kind: 'bolus', id: 'b', date: TEST_NOW, units: iob }] : [],
        carbs: over.cob ? [{ id: 'c', date: TEST_NOW, grams: over.cob }] : [],
        profile: TEST_PROFILE,
        limits: DEFAULT_LIMITS,
        pump: { reservoirUnits: 100, batteryPercent: 80, suspended: false, tempBasal: null, bolusing: false, bolusIncrement: 0.05, basalIncrement: 0.05, lastSync: TEST_NOW },
        iob: { date: TEST_NOW, iob, bolusIob: iob, basalIob: 0, activity: 0 },
        cob: over.cob ?? 0,
    };
}
/** Net extra insulin over the next 30 min implied by a decision, in U. */
export function extraInsulin(d, input) {
    const basal = scheduleValueAt(input.profile.basal, input.now);
    const temp = d.tempBasal ? ((d.tempBasal.rate - basal) * Math.min(30, d.tempBasal.durationMin)) / 60 : 0;
    return temp + (d.autoBolus ?? 0);
}
const finite = (d) => {
    const nums = [d.tempBasal?.rate, d.tempBasal?.durationMin, d.autoBolus].filter((x) => x !== undefined);
    return nums.every((n) => Number.isFinite(n)) ? null : 'non-finite dose';
};
export const conformanceCases = [
    {
        name: 'adds insulin when high and rising',
        input: snapshot({ bg: 220, slope: 6 }),
        check: (d, i) => (extraInsulin(d, i) > 0.1 ? null : `expected extra insulin, got ${extraInsulin(d, i).toFixed(2)} U`),
    },
    {
        name: 'never adds insulin when low',
        input: snapshot({ bg: 68, slope: -3 }),
        check: (d, i) => (extraInsulin(d, i) <= 0 && !d.autoBolus ? null : 'added insulin while low'),
    },
    {
        name: 'reduces insulin when dropping fast towards low',
        input: snapshot({ bg: 105, slope: -9 }),
        check: (d, i) => (extraInsulin(d, i) < 0 ? null : `expected reduction, got ${extraInsulin(d, i).toFixed(2)} U`),
    },
    {
        name: 'stays calm in range and flat',
        input: snapshot({ bg: 105, slope: 0 }),
        check: (d, i) => (Math.abs(extraInsulin(d, i)) < 0.4 && (d.autoBolus ?? 0) < 0.3 ? null : `too aggressive: ${extraInsulin(d, i).toFixed(2)} U`),
    },
    {
        name: 'respects existing IOB when high',
        input: snapshot({ bg: 180, slope: 0, iob: 5 }),
        check: (d, i) => ((d.autoBolus ?? 0) <= 0.5 ? null : `bolused ${d.autoBolus} U on top of 5 U IOB`),
    },
];
/** Runs all conformance cases; returns failures (empty = pass). Also checks determinism. */
export function checkConformance(plugin) {
    const failures = [];
    for (const c of conformanceCases) {
        const d = plugin.decide(c.input, plugin.defaultSettings);
        const problems = [finite(d), c.check(d, c.input), typeof d.reason === 'string' ? null : 'missing reason'].filter(Boolean);
        const again = plugin.decide(c.input, plugin.defaultSettings);
        if (JSON.stringify(again.tempBasal) !== JSON.stringify(d.tempBasal) || again.autoBolus !== d.autoBolus)
            problems.push('non-deterministic');
        problems.forEach((p) => failures.push(`${plugin.meta.id} / ${c.name}: ${p} — ${d.reason}`));
    }
    return failures;
}
