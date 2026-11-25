import { describe, expect, it } from 'vitest';
import { inverseChangeFlags } from '@buddy/core';
import { buildOrefArgs } from '../src/oref/adapter';
import { BUILT_IN_ALGORITHMS, extraInsulin, orefSmb, pid, predictive, snapshot, TEST_NOW } from '../src';
const override = (percentage, extra = {}) => ({
    id: 'o', name: 'o', percentage, target: null, scaleIsf: true, scaleCr: true, disableSmb: false, durationMin: 60, startedAt: TEST_NOW - 60_000, ...extra,
});
const custom = (input) => buildOrefArgs(input, orefSmb.defaultSettings).args[12];
describe.each(BUILT_IN_ALGORITHMS.map((a) => [a.meta.id, a]))('%s honours overrides', (_id, algo) => {
    it('doses more with 150 % and less with 50 % when moderately high', () => {
        const base = snapshot({ bg: 165, slope: 1 });
        const normal = extraInsulin(algo.decide(base, algo.defaultSettings), base);
        const more = extraInsulin(algo.decide({ ...base, override: override(150) }, algo.defaultSettings), base);
        const less = extraInsulin(algo.decide({ ...base, override: override(50) }, algo.defaultSettings), base);
        expect(more).toBeGreaterThanOrEqual(normal);
        expect(less).toBeLessThan(normal);
    });
});
describe('override details', () => {
    it('disables SMB in oref when the override says so', () => {
        const input = { ...snapshot({ bg: 220, slope: 6, cob: 60 }), override: override(100, { disableSmb: true }) };
        expect(orefSmb.decide(input, orefSmb.defaultSettings).autoBolus).toBeUndefined();
    });
    it('disables SMB in oref inside a scheduled all-day window, not outside', () => {
        const base = snapshot({ bg: 220, slope: 6, cob: 60 });
        const on = orefSmb.decide({ ...base, override: override(100) }, orefSmb.defaultSettings);
        expect(on.autoBolus).toBeGreaterThan(0);
        const allDay = override(100, { smbIsScheduledOff: true, smbOffStartHour: 0, smbOffEndHour: 0 });
        expect(orefSmb.decide({ ...base, override: allDay }, orefSmb.defaultSettings).autoBolus).toBeUndefined();
    });
    it('uses the override target', () => {
        const base = snapshot({ bg: 150, slope: 0 });
        const high = predictive.decide({ ...base, override: override(100, { target: 160 }) }, predictive.defaultSettings);
        expect(high.autoBolus ?? 0).toBe(0);
        expect(orefSmb.decide({ ...base, override: override(100, { target: 160 }) }, orefSmb.defaultSettings).debug?.target).toBe(160);
    });
    it('scheduled SMB-off also holds back automatic boluses in pid', () => {
        const base = snapshot({ bg: 220, slope: 6, cob: 60 });
        const allDay = override(100, { smbIsScheduledOff: true, smbOffStartHour: 0, smbOffEndHour: 0 });
        expect(pid.decide({ ...base, override: allDay }, pid.defaultSettings).autoBolus ?? 0).toBe(0);
    });
});
describe('trio_custom_variables mapping (OpenAPS.prepareTrioCustomOrefVariables)', () => {
    it('passes neutral values without an override', () => {
        expect(custom(snapshot({ bg: 120, slope: 0 }))).toMatchObject({
            useOverride: false, overridePercentage: 100, overrideTarget: 0, duration: 0, unlimited: true,
            smbIsOff: false, smbIsScheduledOff: false, start: 0, end: 0, advancedSettings: false,
            isfAndCr: false, isf: false, cr: false, smbMinutes: 30, uamMinutes: 30,
        });
    });
    it.each([
        ['isfAndCr', { isfAndCr: true, isf: true, cr: true }],
        ['isf', { isfAndCr: false, isf: true, cr: false }],
        ['cr', { isfAndCr: false, isf: false, cr: true }],
        ['none', { isfAndCr: false, isf: false, cr: false }],
    ])('maps inverse change %s', (mode, flags) => {
        expect(custom({ ...snapshot({ bg: 120, slope: 0 }), override: override(80, inverseChangeFlags(mode)) })).toMatchObject({ useOverride: true, overridePercentage: 80, ...flags });
    });
    it('maps target, duration, SMB schedule and SMB/UAM minutes', () => {
        const o = override(120, { target: 110, durationMin: 90, smbIsScheduledOff: true, smbOffStartHour: 22, smbOffEndHour: 6, overrideSmbMinutes: true, smbMinutes: 60, uamMinutes: 75 });
        expect(custom({ ...snapshot({ bg: 120, slope: 0 }), override: o })).toMatchObject({
            overrideTarget: 110, duration: 90, unlimited: false, smbIsOff: false, smbIsScheduledOff: true, start: 22, end: 6,
            advancedSettings: true, smbMinutes: 60, uamMinutes: 75,
        });
    });
    it('keeps default SMB minutes while the toggle is off and passes 0 duration when indefinite', () => {
        const o = override(120, { durationMin: null, smbMinutes: 60, uamMinutes: 75, disableSmb: true });
        expect(custom({ ...snapshot({ bg: 120, slope: 0 }), override: o })).toMatchObject({ duration: 0, unlimited: true, smbIsOff: true, advancedSettings: false, smbMinutes: 30, uamMinutes: 30 });
    });
});
