import { describe, expect, it } from 'vitest';
import {
  EMPTY_SNAPSHOT,
  computeIob,
  createMemoryStore,
  insulinStats,
  isExternalDose,
  migrateSnapshot,
  type CarbEntry,
  type DataSnapshot,
  type InsulinDose,
} from '../src';
import { flatProfile, T0 } from './fixtures';

const DAY = 24 * 60 * 60_000;

describe('external insulin', () => {
  it('counts for IOB exactly like a pump bolus of the same size', () => {
    const pump: InsulinDose = { kind: 'bolus', id: 'b', date: T0, units: 2 };
    const external: InsulinDose = { kind: 'bolus', id: 'e', date: T0, units: 2, external: true };

    const iobPump = computeIob([pump], flatProfile, T0 + 30 * 60_000);
    const iobExternal = computeIob([external], flatProfile, T0 + 30 * 60_000);

    expect(iobExternal.iob).toBeCloseTo(iobPump.iob, 10);
    expect(iobExternal.iob).toBeGreaterThan(0);
  });

  it('is recognised by isExternalDose, and pump doses are not', () => {
    expect(isExternalDose({ kind: 'bolus', id: 'e', date: T0, units: 1, external: true })).toBe(true);
    expect(isExternalDose({ kind: 'bolus', id: 'b', date: T0, units: 1 })).toBe(false);
    expect(isExternalDose({ kind: 'smb', id: 's', date: T0, units: 0.1 })).toBe(false);
    expect(isExternalDose({ kind: 'tempBasal', id: 't', date: T0, rate: 1, durationMin: 30 })).toBe(false);
  });

  it('keeps the external flag when the store upserts a dose', () => {
    const store = createMemoryStore();
    store.addDoses([{ kind: 'bolus', id: 'e', date: T0, units: 1, external: true }]);
    expect(store.snapshot().doses[0]).toMatchObject({ external: true });
  });

  it('is reported separately from pump boluses in the insulin statistics', () => {
    const doses: InsulinDose[] = [
      { kind: 'bolus', id: 'b', date: T0, units: 2 },
      { kind: 'bolus', id: 'e', date: T0 + 1, units: 3, external: true },
    ];
    const s = insulinStats(doses, { ...flatProfile, basal: [{ startMinute: 0, value: 0 }] }, T0 - 1, T0 - 1 + DAY);
    expect(s.bolus).toBeCloseTo(2, 6);
    expect(s.external).toBeCloseTo(3, 6);
    expect(s.totalDaily).toBeCloseTo(5, 6);
  });
});

describe('migrateSnapshot', () => {
  const snap = (doses: InsulinDose[], carbs: CarbEntry[] = []): DataSnapshot => ({ ...EMPTY_SNAPSHOT, doses, carbs });

  it('turns legacy ext- boluses into external doses', () => {
    const out = migrateSnapshot(snap([{ kind: 'bolus', id: 'ext-abc', date: T0, units: 1.5 }]));
    expect(out.doses).toEqual([{ kind: 'bolus', id: 'ext-abc', date: T0, units: 1.5, external: true }]);
  });

  it('leaves pump doses and already external doses untouched', () => {
    const doses: InsulinDose[] = [
      { kind: 'bolus', id: 'pump-1', date: T0, units: 1 },
      { kind: 'bolus', id: 'ext-x', date: T0, units: 1, external: true },
      { kind: 'tempBasal', id: 'ext-temp', date: T0, rate: 1, durationMin: 30 },
    ];
    const input = snap(doses);
    const out = migrateSnapshot(input);
    expect(out.doses).toEqual(doses);
    expect(out).toBe(input);
  });

  it('is idempotent', () => {
    const once = migrateSnapshot(snap([{ kind: 'bolus', id: 'ext-1', date: T0, units: 1 }]));
    expect(migrateSnapshot(once)).toBe(once);
  });
});

describe('carb notes', () => {
  it('stores the note on a carb entry and keeps it in the snapshot', () => {
    const store = createMemoryStore();
    store.addCarbs({ id: 'c', date: T0, grams: 30, note: 'Pizza' });
    expect(store.snapshot().carbs[0]?.note).toBe('Pizza');
  });
});

describe('dose store input validation', () => {
  it('drops doses with a non-finite date or amount so IOB can never become NaN', () => {
    // Arrange
    const store = createMemoryStore();

    // Act
    store.addDoses([
      { kind: 'bolus', id: 'nan-date', date: Number.NaN, units: 1 },
      { kind: 'bolus', id: 'nan-units', date: 1_000, units: Number.NaN },
      { kind: 'bolus', id: 'ok', date: 1_000, units: 1 },
    ]);

    // Assert
    expect(store.snapshot().doses.map((d) => d.id)).toEqual(['ok']);
  });
});
