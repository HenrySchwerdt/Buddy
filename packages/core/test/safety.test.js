import { describe, expect, it } from 'vitest';
import { guardDecision, guardManualBolus, DEFAULT_LIMITS, MINUTE } from '../src';
import { makeInput, pumpState, T0 } from './fixtures';
const codes = (r) => r.interventions.map((i) => i.code);
describe('SafetyGuard', () => {
    it('passes a reasonable decision through unchanged', () => {
        const r = guardDecision(makeInput({ bg: 160 }), { tempBasal: { rate: 1.5, durationMin: 30 }, reason: 'x' });
        expect(r.interventions).toEqual([]);
        expect(r.decision.tempBasal).toEqual({ rate: 1.5, durationMin: 30 });
    });
    it('clamps temp basal to the max basal rate', () => {
        const r = guardDecision(makeInput({ bg: 250 }), { tempBasal: { rate: 9, durationMin: 30 }, reason: '' });
        expect(r.decision.tempBasal.rate).toBe(DEFAULT_LIMITS.maxBasalRate);
        expect(codes(r)).toContain('basal-clamped');
    });
    it('never allows a negative rate and floors to the pump increment', () => {
        expect(guardDecision(makeInput({ bg: 120 }), { tempBasal: { rate: -1, durationMin: 30 }, reason: '' }).decision.tempBasal.rate).toBe(0);
        expect(guardDecision(makeInput({ bg: 160 }), { tempBasal: { rate: 1.234, durationMin: 30 }, reason: '' }).decision.tempBasal.rate).toBe(1.2);
    });
    it('forces a zero temp and blocks boluses when glucose is low', () => {
        const r = guardDecision(makeInput({ bg: 65 }), { tempBasal: { rate: 2, durationMin: 30 }, autoBolus: 0.5, reason: '' });
        expect(r.decision.tempBasal).toEqual({ rate: 0, durationMin: 30 });
        expect(r.decision.autoBolus).toBeUndefined();
        expect(codes(r)).toContain('low-glucose-suspend');
    });
    it('also suspends when glucose is falling quickly towards the threshold', () => {
        const r = guardDecision(makeInput({ bg: 90, slope: -8 }), { autoBolus: 0.3, reason: '' });
        expect(codes(r)).toContain('low-glucose-suspend');
    });
    it('cancels temps on stale CGM data', () => {
        const input = makeInput({ bg: 200, now: T0 + 20 * MINUTE, glucose: makeInput({ bg: 200 }).glucose });
        const r = guardDecision({ ...input, glucoseStatus: makeInput({ bg: 200 }).glucoseStatus }, { tempBasal: { rate: 2, durationMin: 30 }, autoBolus: 1, reason: '' });
        expect(r.decision.tempBasal).toBeNull();
        expect(r.decision.autoBolus).toBeUndefined();
        expect(codes(r)).toContain('stale-glucose');
    });
    it('rejects NaN output', () => {
        const r = guardDecision(makeInput(), { tempBasal: { rate: Number.NaN, durationMin: 30 }, reason: '' });
        expect(r.decision.tempBasal).toBeNull();
        expect(codes(r)).toEqual(['invalid-output']);
    });
    it('does nothing while the pump is suspended', () => {
        const r = guardDecision(makeInput({ bg: 250, pump: pumpState({ suspended: true }) }), { tempBasal: { rate: 2, durationMin: 30 }, autoBolus: 1, reason: '' });
        expect(r.decision.tempBasal).toBeUndefined();
        expect(r.decision.autoBolus).toBeUndefined();
    });
    it('limits automatic boluses by max auto bolus and remaining IOB room', () => {
        const r1 = guardDecision(makeInput({ bg: 250 }), { autoBolus: 3, reason: '' });
        expect(r1.decision.autoBolus).toBe(DEFAULT_LIMITS.maxAutoBolus);
        const input = makeInput({ bg: 250, iob: { date: T0, iob: 5.7, bolusIob: 5.7, basalIob: 0, activity: 0 } });
        const r2 = guardDecision(input, { autoBolus: 1, reason: '' });
        expect(r2.decision.autoBolus).toBe(0.3);
        expect(codes(r2)).toContain('bolus-clamped-iob');
    });
    it('blocks high temps once max IOB is reached', () => {
        const input = makeInput({ bg: 250, iob: { date: T0, iob: 7, bolusIob: 7, basalIob: 0, activity: 0 } });
        const r = guardDecision(input, { tempBasal: { rate: 3, durationMin: 30 }, autoBolus: 1, reason: '' });
        expect(r.decision.tempBasal.rate).toBe(1);
        expect(r.decision.autoBolus).toBeUndefined();
    });
    it('enforces the minimum interval between automatic boluses', () => {
        const input = makeInput({ bg: 250, doses: [{ kind: 'smb', id: 's', date: T0 - 2 * MINUTE, units: 0.2 }] });
        const r = guardDecision(input, { autoBolus: 0.5, reason: '' });
        expect(r.decision.autoBolus).toBeUndefined();
        expect(codes(r)).toContain('bolus-too-soon');
    });
    it('clamps temp duration', () => {
        const r = guardDecision(makeInput({ bg: 150 }), { tempBasal: { rate: 1, durationMin: 600 }, reason: '' });
        expect(r.decision.tempBasal.durationMin).toBe(120);
    });
    it('limits manual boluses', () => {
        expect(guardManualBolus(12, 10, 0.05)).toEqual({ units: 10, warnings: ['Limited to max bolus 10 U.'] });
        expect(guardManualBolus(1.23, 10, 0.1).units).toBe(1.2);
        expect(guardManualBolus(-1, 10, 0.1).units).toBe(0);
    });
});
