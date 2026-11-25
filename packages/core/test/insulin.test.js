import { describe, expect, it } from 'vitest';
import { computeIob, exponentialCurve, insulinModelFor, projectIob, totalDelivered, MINUTE, HOUR } from '../src';
import { flatProfile, T0 } from './fixtures';
const model = insulinModelFor(flatProfile);
describe('exponential insulin curve', () => {
    it('starts at full IOB and ends at zero after DIA', () => {
        expect(exponentialCurve(model, 0).iob).toBeCloseTo(1, 5);
        expect(exponentialCurve(model, model.diaMinutes).iob).toBe(0);
    });
    it('decreases monotonically', () => {
        let prev = 1;
        for (let t = 5; t < model.diaMinutes; t += 5) {
            const { iob } = exponentialCurve(model, t);
            expect(iob).toBeLessThanOrEqual(prev + 1e-12);
            prev = iob;
        }
    });
    it('activity integrates to ~1 U and peaks near the configured peak', () => {
        let sum = 0;
        let peakT = 0;
        let peak = 0;
        for (let t = 0; t < model.diaMinutes; t += 1) {
            const a = exponentialCurve(model, t).activity;
            sum += a;
            if (a > peak)
                [peak, peakT] = [a, t];
        }
        expect(sum).toBeCloseTo(1, 2);
        expect(Math.abs(peakT - model.peakMinutes)).toBeLessThanOrEqual(1);
    });
});
describe('IOB from dose history', () => {
    it('counts a bolus fully at delivery', () => {
        const iob = computeIob([{ kind: 'bolus', id: 'b', date: T0, units: 2 }], flatProfile, T0);
        expect(iob.iob).toBeCloseTo(2, 5);
        expect(iob.bolusIob).toBeCloseTo(2, 5);
    });
    it('treats a zero temp as negative net insulin relative to the schedule', () => {
        const doses = [{ kind: 'tempBasal', id: 't', date: T0, rate: 0, durationMin: 60 }];
        const iob = computeIob(doses, flatProfile, T0 + HOUR);
        expect(iob.basalIob).toBeLessThan(-0.7);
        expect(iob.basalIob).toBeGreaterThan(-1);
    });
    it('truncates a temp basal when a newer one starts', () => {
        const doses = [
            { kind: 'tempBasal', id: 'a', date: T0, rate: 3, durationMin: 120 },
            { kind: 'tempBasal', id: 'b', date: T0 + 30 * MINUTE, rate: 1, durationMin: 30 },
        ];
        expect(totalDelivered(doses, T0, T0 + 2 * HOUR)).toBeCloseTo(1.5 + 0.5, 5);
    });
    it('projects zero-temp IOB below regular IOB', () => {
        const doses = [{ kind: 'bolus', id: 'b', date: T0, units: 1 }];
        const normal = projectIob(doses, flatProfile, T0, 60);
        const zero = projectIob(doses, flatProfile, T0, 60, true);
        expect(normal).toHaveLength(13);
        expect(zero.at(-1).iob).toBeLessThan(normal.at(-1).iob);
    });
});
