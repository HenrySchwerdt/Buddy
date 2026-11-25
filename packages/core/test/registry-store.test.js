import { describe, expect, it } from 'vitest';
import { createMemoryStore, createRegistry, normalizeSettings, validateSettings } from '../src';
import { T0 } from './fixtures';
describe('registry', () => {
    it('registers, lists and rejects duplicates and bad ids', () => {
        const r = createRegistry([{ meta: { id: 'a-b' } }]);
        expect(r.list()).toHaveLength(1);
        expect(() => r.register({ meta: { id: 'a-b' } })).toThrow(/already/);
        expect(() => r.register({ meta: { id: 'Bad Id' } })).toThrow(/kebab/);
        expect(() => r.require('nope')).toThrow(/Unknown/);
    });
});
describe('memory store', () => {
    it('dedupes and sorts while keeping snapshots immutable', () => {
        const s = createMemoryStore();
        const before = s.snapshot();
        s.addGlucose([{ date: T0 + 1, value: 100, source: 'x' }, { date: T0, value: 90, source: 'x' }]);
        s.addGlucose([{ date: T0, value: 90, source: 'x' }]);
        expect(before.glucose).toHaveLength(0);
        expect(s.snapshot().glucose.map((g) => g.value)).toEqual([90, 100]);
    });
    it('notifies subscribers and prunes', () => {
        const s = createMemoryStore();
        let calls = 0;
        const off = s.subscribe(() => calls++);
        s.addCarbs({ id: 'c', date: T0, grams: 20 });
        s.prune(T0 + 1);
        off();
        s.addCarbs({ id: 'd', date: T0, grams: 20 });
        expect(calls).toBe(2);
    });
});
describe('settings schema', () => {
    const schema = [
        { title: 't', fields: [{ kind: 'number', key: 'n', label: 'N', min: 0, max: 10, step: 1 }, { kind: 'boolean', key: 'b', label: 'B' }] },
    ];
    it('validates and clamps', () => {
        expect(validateSettings(schema, { n: 11, b: true })).toHaveLength(1);
        expect(normalizeSettings(schema, { n: 5, b: false }, { n: 99 })).toEqual({ n: 10, b: false });
    });
});
describe('dose upsert', () => {
    it('replaces a dose when the pump re-reports the same id with new contents', () => {
        const s = createMemoryStore();
        s.addDoses([{ kind: 'tempBasal', id: 't1', date: T0, rate: 0, durationMin: 30 }]);
        s.addDoses([{ kind: 'tempBasal', id: 't1', date: T0, rate: 0, durationMin: 10 }]);
        s.addDoses([{ kind: 'bolus', id: 'b1', date: T0 + 1, units: 0.4 }]);
        s.addDoses([{ kind: 'bolus', id: 'b1', date: T0 + 1, units: 1.0 }]);
        expect(s.snapshot().doses).toEqual([
            { kind: 'tempBasal', id: 't1', date: T0, rate: 0, durationMin: 10 },
            { kind: 'bolus', id: 'b1', date: T0 + 1, units: 1.0 },
        ]);
    });
    it('does not notify when nothing changed', () => {
        const s = createMemoryStore();
        s.addDoses([{ kind: 'bolus', id: 'b', date: T0, units: 1 }]);
        let calls = 0;
        s.subscribe(() => calls++);
        s.addDoses([{ kind: 'bolus', id: 'b', date: T0, units: 1 }]);
        expect(calls).toBe(0);
    });
});
describe('glucose removal', () => {
    it('removes exactly one reading', () => {
        const s = createMemoryStore();
        s.addGlucose([{ date: T0, value: 90, source: 'manual' }, { date: T0, value: 95, source: 'cgm' }]);
        s.removeGlucose('manual', T0);
        expect(s.snapshot().glucose).toEqual([{ date: T0, value: 95, source: 'cgm' }]);
    });
});
