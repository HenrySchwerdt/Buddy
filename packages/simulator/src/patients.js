import { BASE_PARAMS, addBolus, addMeal, basalForTarget, glucoseMgdl, steadyState, step } from './hovorka';
/** Wilinska's sensitivities give unusually low insulin needs; scale to typical adult TDDs. */
const COHORT_SI_SCALE = 0.6;
const patient = (id, name, description, over) => {
    const { siScale = 1, ...rest } = over;
    return {
        id,
        name,
        description,
        params: {
            ...BASE_PARAMS,
            ...rest,
            SIT: BASE_PARAMS.SIT * siScale * COHORT_SI_SCALE,
            SID: BASE_PARAMS.SID * siScale * COHORT_SI_SCALE,
            SIE: BASE_PARAMS.SIE * siScale * COHORT_SI_SCALE,
        },
    };
};
/** A small, fixed cohort spanning body weight, insulin sensitivity and absorption speed. */
export const COHORT = [
    patient('adult-avg', 'Alex', 'Average adult, 70 kg', {}),
    patient('adult-resistant', 'Blake', '95 kg, insulin resistant (SI ×0.6)', { BW: 95, siScale: 0.6 }),
    patient('adult-sensitive', 'Casey', '58 kg, insulin sensitive (SI ×1.5)', { BW: 58, siScale: 1.5 }),
    patient('teen-fast', 'Dana', '55 kg, fast carb absorption, high EGP', { BW: 55, tmaxG: 30, EGP0: 0.019, siScale: 1.1 }),
    patient('adult-slow', 'Eli', '80 kg, slow insulin absorption', { BW: 80, tmaxI: 75, siScale: 0.85 }),
];
export const findPatient = (id) => {
    const p = COHORT.find((x) => x.id === id);
    if (!p)
        throw new Error(`Unknown virtual patient "${id}"`);
    return p;
};
/**
 * Measures the patient's "true" therapy settings from the model itself:
 * basal = steady state at 110 mg/dL; ISF = glucose difference 5 h after an extra 1 U;
 * CR = ISF ÷ glucose rise per gram. Cached per patient.
 */
export function trueSettings(p) {
    const cached = cache.get(p.id);
    if (cached)
        return cached;
    const params = p.params;
    const basal = basalForTarget(params, 110);
    const high = basalForTarget(params, 180);
    const s0 = steadyState(params, high);
    const u = (high * 1000) / 60;
    const after = (s) => glucoseMgdl(params, step(params, s, u, 300));
    const base = after(s0);
    const isf = base - after(addBolus(s0, 1));
    const perGram = (after(addMeal(params, s0, 10)) - base) / 10;
    const result = { basal, isf, carbRatio: isf / perGram };
    cache.set(p.id, result);
    return result;
}
const cache = new Map();
const round = (x, step) => Math.round(x / step) * step;
/**
 * Pump profile for a virtual patient. `mismatch` scales the profile away from the truth to
 * test algorithm robustness (0.8 = profile underdoses by 20 %, 1.25 = overdoses by 25 %).
 */
export function profileFor(p, mismatch = 1) {
    const t = trueSettings(p);
    return {
        basal: [{ startMinute: 0, value: round(t.basal * mismatch, 0.05) }],
        isf: [{ startMinute: 0, value: round(t.isf / mismatch, 1) }],
        carbRatio: [{ startMinute: 0, value: round(t.carbRatio / mismatch, 0.5) }],
        target: [{ startMinute: 0, value: { low: 100, high: 110 } }],
        diaHours: 6,
        insulinCurve: 'rapid-acting',
    };
}
