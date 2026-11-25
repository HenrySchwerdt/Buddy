import { describe, expect, it } from 'vitest';
import { BASE_PARAMS, basalForTarget, glucoseMgdl, steadyState, step, addMeal, addBolus, COHORT, profileFor } from '../src';
describe('Hovorka model', () => {
    it('finds a basal that holds 110 mg/dL and stays there', () => {
        const basal = basalForTarget(BASE_PARAMS, 110);
        expect(basal).toBeGreaterThan(0.3);
        expect(basal).toBeLessThan(3);
        const s0 = steadyState(BASE_PARAMS, basal);
        expect(glucoseMgdl(BASE_PARAMS, s0)).toBeCloseTo(110, 0);
        const s1 = step(BASE_PARAMS, s0, (basal * 1000) / 60, 240);
        expect(glucoseMgdl(BASE_PARAMS, s1)).toBeCloseTo(110, 0);
    });
    it('rises after a meal and falls after a bolus', () => {
        const basal = basalForTarget(BASE_PARAMS, 110);
        const u = (basal * 1000) / 60;
        const s0 = steadyState(BASE_PARAMS, basal);
        const meal = step(BASE_PARAMS, addMeal(BASE_PARAMS, s0, 50), u, 90);
        expect(glucoseMgdl(BASE_PARAMS, meal)).toBeGreaterThan(160);
        const bolus = step(BASE_PARAMS, addBolus(s0, 2), u, 180);
        expect(glucoseMgdl(BASE_PARAMS, bolus)).toBeLessThan(90);
    });
    it('derives sane profiles for the whole cohort', () => {
        for (const p of COHORT) {
            const prof = profileFor(p);
            const basal = prof.basal[0].value;
            expect(basal, p.id).toBeGreaterThan(0.2);
            expect(prof.isf[0].value, p.id).toBeGreaterThan(15);
            expect(prof.carbRatio[0].value, p.id).toBeGreaterThan(3);
        }
    });
});
