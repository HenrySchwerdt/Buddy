import { describe, expect, it } from 'vitest';
import type { InsulinDose } from '@buddy/core';
import { glucoseSyncId, planHealthUpload, pruneLedger, syncIdForDeletion, type HealthSnapshot } from '../health/samples';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const empty: HealthSnapshot = { glucose: [], doses: [], carbs: [] };
const plan = (snap: Partial<HealthSnapshot>, uploaded: string[] = [], bolusIncrement?: number) => planHealthUpload({ ...empty, ...snap }, { now: NOW, uploaded: new Set(uploaded), ...(bolusIncrement ? { bolusIncrement } : {}) });

describe('planHealthUpload', () => {
  it('writes glucose once, keyed like the Nightscout identifier', () => {
    const g = { date: NOW - 5 * MIN, value: 123.4, source: 'dexcom-g7' };
    const first = plan({ glucose: [g] });
    expect(first).toEqual([{ kind: 'glucose', key: `glucose:${glucoseSyncId('dexcom-g7', g.date)}`, syncId: `dexcom-g7-${g.date}`, date: g.date, mgdl: 123 }]);
    expect(plan({ glucose: [g] }, [first[0]!.key])).toEqual([]);
  });

  it('skips invalid, future and too old glucose', () => {
    const r = [
      { date: NOW + MIN, value: 100, source: 'x' },
      { date: NOW - 30 * 60 * MIN, value: 100, source: 'x' },
      { date: NOW - MIN, value: 0, source: 'x' },
      { date: NOW - MIN, value: Number.NaN, source: 'x' },
    ];
    expect(plan({ glucose: r })).toEqual([]);
  });

  it('writes meals but not carb equivalents or imported entries, and also backdated ones', () => {
    const s = plan({
      carbs: [
        { id: 'carbs-1', date: NOW - 20 * MIN, grams: 30 },
        { id: 'fpu-1', date: NOW - 10 * MIN, grams: 12 },
        { id: 'ns-carb-1', date: NOW - 10 * MIN, grams: 12 },
        { id: 'carbs-2', date: NOW + 30 * MIN, grams: 12 },
      ],
    });
    expect(s.map((x) => x.key)).toEqual(['carbs:carbs-1']);
    // an entry backdated behind an already uploaded one is still picked up
    const later = plan({ carbs: [{ id: 'carbs-1', date: NOW - 20 * MIN, grams: 30 }, { id: 'carbs-3', date: NOW - 60 * MIN, grams: 10 }] }, ['carbs:carbs-1']);
    expect(later.map((x) => x.key)).toEqual(['carbs:carbs-3']);
  });

  it('writes boluses, SMBs and external insulin as bolus samples', () => {
    const doses: InsulinDose[] = [
      { kind: 'bolus', id: 'b1', date: NOW - 30 * MIN, units: 2.06 },
      { kind: 'smb', id: 'b2', date: NOW - 20 * MIN, units: 0.3 },
      { kind: 'bolus', id: 'e1', date: NOW - 10 * MIN, units: 1, external: true },
      { kind: 'bolus', id: 'ns-b', date: NOW - 10 * MIN, units: 1 },
    ];
    const s = plan({ doses }, [], 0.1);
    expect(s.map((x) => x.syncId)).toEqual(['b1', 'b2', 'e1']);
    expect(s.every((x) => x.kind === 'insulin' && x.reason === 'bolus')).toBe(true);
    expect(s[0]).toMatchObject({ units: 2.1 });
    expect(s[2]).toMatchObject({ external: true });
  });

  it('writes a temp basal only after it settled and cuts it where the next one starts', () => {
    const doses: InsulinDose[] = [
      { kind: 'tempBasal', id: 't1', date: NOW - 60 * MIN, rate: 1.2, durationMin: 30 },
      { kind: 'tempBasal', id: 't2', date: NOW - 40 * MIN, rate: 0.6, durationMin: 30 },
      { kind: 'tempBasal', id: 't3', date: NOW - 10 * MIN, rate: 2, durationMin: 30 },
    ];
    const s = plan({ doses });
    // t1 is cut after 20 of 30 minutes by t2, t2 runs its 30 minutes up to t3, t3 is still running
    expect(s.map((x) => x.syncId)).toEqual(['t1', 't2']);
    expect(s[0]).toMatchObject({ kind: 'insulin', reason: 'basal', units: 0.4, start: NOW - 60 * MIN, end: NOW - 40 * MIN });
    expect(s[1]).toMatchObject({ units: 0.3, end: NOW - 10 * MIN });
  });

  it('a cancelling temp (duration 0) truncates the one before it', () => {
    const doses: InsulinDose[] = [
      { kind: 'tempBasal', id: 't1', date: NOW - 50 * MIN, rate: 2, durationMin: 60 },
      { kind: 'tempBasal', id: 't0', date: NOW - 20 * MIN, rate: 0, durationMin: 0 },
    ];
    const s = plan({ doses });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ syncId: 't1', units: 1, end: NOW - 20 * MIN });
  });

  it('caps each kind per round, oldest first', () => {
    const glucose = Array.from({ length: 400 }, (_, i) => ({ date: NOW - (400 - i) * MIN, value: 100, source: 's' }));
    const s = plan({ glucose });
    expect(s).toHaveLength(300);
    expect(s[0]).toMatchObject({ date: NOW - 400 * MIN });
  });
});

describe('helpers', () => {
  it('prunes the ledger', () => {
    expect(Object.keys(pruneLedger({ a: NOW, b: NOW - 30 * 60 * MIN }, NOW))).toEqual(['a']);
  });
  it('derives deletion ids', () => {
    expect(syncIdForDeletion('carbs', 'carbs-1', 5)).toBe('carbs-1');
    expect(syncIdForDeletion('glucose', 'dexcom', 1000)).toBe('dexcom-1000');
    expect(syncIdForDeletion('glucose', 'dexcom-1000', 1000)).toBe('dexcom-1000');
  });
});
