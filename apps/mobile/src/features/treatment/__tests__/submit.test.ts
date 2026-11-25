import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarbEntry, InsulinDose } from '@buddy/core';

const NOW = Date.UTC(2026, 10, 25, 12);
const MIN = 60_000;

const runtime = vi.hoisted(() => ({
  deliverBolus: vi.fn(async (u: number) => u),
  logCarbs: vi.fn(async () => {}),
  runLoop: vi.fn(async () => null),
  now: vi.fn(() => 0),
  store: { addDoses: vi.fn(), addCarbs: vi.fn(), snapshot: vi.fn(() => ({ glucose: [{ date: 0 }], doses: [], carbs: [], loopRuns: [] })) },
}));
vi.mock('@/runtime/runtime', () => runtime);
vi.mock('../use-treatment-model', () => ({ STALE_GLUCOSE_MS: 6 * 60_000 }));

import { invokeTreatments, type TreatmentRequest } from '../submit';

const request = (over: Partial<TreatmentRequest> = {}): TreatmentRequest => ({
  carbs: 0,
  fat: 0,
  protein: 0,
  amount: 0,
  note: '',
  externalInsulin: false,
  date: NOW,
  backdated: false,
  maxBolus: 10,
  maxCarbs: 250,
  maxFat: 250,
  maxProtein: 250,
  fpu: { individualAdjustmentFactor: 0.5, delay: 60, minuteInterval: 30 },
  ...over,
});

const addedDoses = () => runtime.store.addDoses.mock.calls.flatMap((c) => c[0] as InsulinDose[]);
const addedCarbs = () => runtime.store.addCarbs.mock.calls.map((c) => c[0] as CarbEntry);

beforeEach(() => {
  vi.clearAllMocks();
  runtime.now.mockReturnValue(NOW);
  runtime.store.snapshot.mockReturnValue({ glucose: [{ date: NOW - MIN }], doses: [], carbs: [], loopRuns: [] });
});

describe('external insulin', () => {
  it('is recorded as an external bolus and never sent to the pump', async () => {
    const outcome = await invokeTreatments(request({ amount: 2, externalInsulin: true }));

    expect(outcome).toEqual({ ok: true });
    expect(runtime.deliverBolus).not.toHaveBeenCalled();
    expect(addedDoses()).toHaveLength(1);
    expect(addedDoses()[0]).toMatchObject({ kind: 'bolus', units: 2, external: true, date: NOW });
  });

  it('gets an id that cannot be mistaken for a pump record', async () => {
    await invokeTreatments(request({ amount: 1, externalInsulin: true }));
    expect(addedDoses()[0]?.id).toMatch(/^external-/);
  });

  it('rejects more than three times the max bolus instead of storing less than was injected', async () => {
    const outcome = await invokeTreatments(request({ amount: 99, externalInsulin: true, maxBolus: 10 }));
    expect(outcome.ok).toBe(false);
    expect(addedDoses()).toHaveLength(0);
    expect(runtime.deliverBolus).not.toHaveBeenCalled();
  });

  it('accepts exactly three times the max bolus', async () => {
    await invokeTreatments(request({ amount: 30, externalInsulin: true, maxBolus: 10 }));
    expect(addedDoses()[0]).toMatchObject({ units: 30 });
  });

  it('rejects a non-finite amount or date without storing anything', async () => {
    expect((await invokeTreatments(request({ amount: Number.NaN, externalInsulin: true }))).ok).toBe(false);
    expect((await invokeTreatments(request({ amount: 1, externalInsulin: true, date: Number.NaN }))).ok).toBe(false);
    expect(addedDoses()).toHaveLength(0);
  });

  it('reports success when stored even if glucose is stale, so the user does not enter it twice', async () => {
    runtime.store.snapshot.mockReturnValue({ glucose: [{ date: NOW - 60 * MIN }], doses: [], carbs: [], loopRuns: [] });
    const outcome = await invokeTreatments(request({ amount: 2, externalInsulin: true }));
    expect(outcome).toEqual({ ok: true });
  });

  it('says the dose was recorded when the loop run afterwards fails', async () => {
    runtime.runLoop.mockRejectedValueOnce(new Error('pump unreachable'));
    const outcome = await invokeTreatments(request({ amount: 2, externalInsulin: true }));
    expect(addedDoses()).toHaveLength(1);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.message).toMatch(/recorded/i);
  });

  it('is never dated in the future', async () => {
    await invokeTreatments(request({ amount: 1, externalInsulin: true, date: NOW + 30 * MIN }));
    expect(addedDoses()[0]?.date).toBe(NOW);
  });

  it('keeps a backdated time', async () => {
    await invokeTreatments(request({ amount: 1, externalInsulin: true, date: NOW - 45 * MIN, backdated: true }));
    expect(addedDoses()[0]?.date).toBe(NOW - 45 * MIN);
  });

  it('a normal bolus still goes to the pump and is not stored as external', async () => {
    await invokeTreatments(request({ amount: 2 }));
    expect(runtime.deliverBolus).toHaveBeenCalledWith(2);
    expect(addedDoses()).toHaveLength(0);
  });
});

describe('carb notes', () => {
  it('passes the note when carbs are logged now', async () => {
    await invokeTreatments(request({ carbs: 30, note: 'Pizza' }));
    expect(runtime.logCarbs).toHaveBeenCalledWith(30, undefined, 'Pizza');
  });

  it('stores the note on a backdated carb entry', async () => {
    await invokeTreatments(request({ carbs: 30, note: 'Pizza', date: NOW - 20 * MIN, backdated: true }));
    expect(addedCarbs()[0]).toMatchObject({ grams: 30, note: 'Pizza', date: NOW - 20 * MIN });
  });

  it('trims the note and omits it when blank', async () => {
    await invokeTreatments(request({ carbs: 30, note: '   ', date: NOW - 20 * MIN, backdated: true }));
    expect(addedCarbs()[0]).not.toHaveProperty('note');
    runtime.store.addCarbs.mockClear();
    await invokeTreatments(request({ carbs: 30, note: '  Lunch ', date: NOW - 20 * MIN, backdated: true }));
    expect(addedCarbs()[0]?.note).toBe('Lunch');
  });

  it('keeps the note off the fat and protein carb equivalents, like Trio', async () => {
    await invokeTreatments(request({ carbs: 30, fat: 40, protein: 40, note: 'Pizza', date: NOW - 5 * MIN, backdated: true }));
    const [main, ...fpu] = addedCarbs();
    expect(main?.note).toBe('Pizza');
    expect(fpu.length).toBeGreaterThan(0);
    expect(fpu.every((e) => e.note === undefined)).toBe(true);
  });
});
