import { defineAlgorithm, effectiveSettings } from '@buddy/core';
import { minOf, predictGlucose } from '../shared/predict';
const TEMP_DURATION = 30;
const r2 = (x) => Math.round(x * 100) / 100;
/**
 * Prediction-based dosing in the spirit of Loop: forecast eventual glucose from insulin,
 * carbs and momentum, then dose the difference to the correction target — either as a
 * temp basal or as a partial automatic bolus. Clean-room implementation, not Loop's code.
 */
export const predictive = defineAlgorithm({
    meta: {
        id: 'predictive',
        name: 'Predictive (Loop-style)',
        shortName: 'Predict',
        description: 'Forecasts eventual glucose from insulin, carbs and momentum and doses the difference to target. Choose temp basal only or partial automatic boluses (like Loop).',
        version: '1.0.0',
        author: 'Buddy contributors',
        maturity: 'experimental',
        capabilities: { tempBasal: true, autoBolus: true, predictions: ['main', 'zt'] },
    },
    settings: [
        {
            title: 'Dosing',
            fields: [
                { kind: 'select', key: 'dosingStrategy', label: 'Dosing strategy', options: [{ value: 'tempBasal', label: 'Temp basal only' }, { value: 'automaticBolus', label: 'Automatic bolus' }] },
                { kind: 'number', key: 'partialApplication', label: 'Partial application', help: 'Share of the required correction given per automatic bolus.', min: 0.1, max: 0.8, step: 0.05, affectsDosing: true },
                { kind: 'number', key: 'correctionMinutes', label: 'Temp basal correction window', unit: 'min', min: 30, max: 120, step: 15, affectsDosing: true },
                { kind: 'number', key: 'momentumMinutes', label: 'Momentum horizon', unit: 'min', min: 5, max: 30, step: 5 },
            ],
        },
    ],
    defaultSettings: { dosingStrategy: 'automaticBolus', partialApplication: 0.4, momentumMinutes: 15, correctionMinutes: 30 },
    decide(input, s) {
        const { profile, now, limits } = input;
        const eff = effectiveSettings(profile, now, input.override, input.tempTarget);
        const basal = eff.basal;
        const isf = eff.isf;
        const range = eff.target;
        const target = (range.low + range.high) / 2;
        const main = predictGlucose(input, { horizonMinutes: 360, momentumMinutes: s.momentumMinutes });
        const zt = predictGlucose(input, { horizonMinutes: 240, momentumMinutes: s.momentumMinutes, zeroTemp: true });
        const eventual = main.at(-1);
        const minPredicted = minOf(main.slice(0, 37));
        const predictions = { main, zt };
        const base = { predictions, eventualGlucose: eventual, debug: { minPredicted, target, isf } };
        if (minOf(zt.slice(0, 13)) < limits.suspendThreshold) {
            return { ...base, tempBasal: { rate: 0, durationMin: TEMP_DURATION }, reason: `Zero-temp forecast dips below ${limits.suspendThreshold} within 1 h: suspend.` };
        }
        if (minPredicted < range.low || eventual < range.low) {
            const lowest = Math.min(minPredicted, eventual);
            const deficit = (lowest - target) / isf;
            const rate = Math.max(0, basal + deficit / (s.correctionMinutes / 60));
            return { ...base, tempBasal: { rate: r2(rate), durationMin: TEMP_DURATION }, insulinReq: r2(deficit), reason: `Forecast low ${Math.round(lowest)} mg/dL; reducing basal to ${r2(rate)} U/h.` };
        }
        if (eventual <= range.high) {
            return { ...base, tempBasal: null, insulinReq: 0, reason: `Eventual ${Math.round(eventual)} mg/dL in range; scheduled basal.` };
        }
        const insulinReq = Math.min((eventual - target) / isf, Math.max(0, limits.maxIOB - input.iob.iob));
        if (s.dosingStrategy === 'automaticBolus' && !eff.smbDisabled) {
            const bolus = insulinReq * s.partialApplication;
            return { ...base, tempBasal: null, autoBolus: r2(bolus), insulinReq: r2(insulinReq), reason: `Eventual ${Math.round(eventual)} mg/dL; need ${r2(insulinReq)} U, bolusing ${Math.round(s.partialApplication * 100)} % = ${r2(bolus)} U.` };
        }
        const rate = basal + insulinReq / (s.correctionMinutes / 60);
        return { ...base, tempBasal: { rate: r2(rate), durationMin: TEMP_DURATION }, insulinReq: r2(insulinReq), reason: `Eventual ${Math.round(eventual)} mg/dL; need ${r2(insulinReq)} U → temp ${r2(rate)} U/h.` };
    },
});
