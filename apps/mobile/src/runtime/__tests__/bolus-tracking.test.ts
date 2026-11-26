import { describe, expect, it, vi } from 'vitest';
import type { InsulinDose } from '@buddy/core';
import { createBolusGate, deliveredSince, recordDeliveredBolus, withBolusProgress } from '../bolus-tracking';

const dose = (units: number, date: number, external?: boolean): InsulinDose => ({ kind: 'bolus', id: `b${date}`, date, units, ...(external ? { external } : {}) });

describe('deliveredSince', () => {
  it('sums pump boluses since the start and caps at the total', () => {
    expect(deliveredSince([dose(1, 100), dose(0.5, 200), dose(9, 50), dose(2, 300, true)], 100, 3)).toBe(1.5);
    expect(deliveredSince([dose(5, 100)], 100, 3)).toBe(3);
  });
});

describe('withBolusProgress', () => {
  it('begins, reports delivered units, completes and always ends', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const tracker = { begin: (t: number) => calls.push(`begin ${t}`), setDelivered: (d: number) => calls.push(`delivered ${d}`), end: () => calls.push('end') };
    const pump = { history: vi.fn(async () => [dose(1, 1000)]) };
    const run = withBolusProgress(tracker, pump, 2, () => 1000, () => new Promise<string>((r) => setTimeout(() => r('ok'), 5000)), 2000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await run).toBe('ok');
    expect(calls[0]).toBe('begin 2');
    expect(calls).toContain('delivered 1');
    expect(calls.at(-2)).toBe('delivered 2');
    expect(calls.at(-1)).toBe('end');
    vi.useRealTimers();
  });

  it('ends when delivery fails', async () => {
    const calls: string[] = [];
    const tracker = { begin: () => calls.push('begin'), setDelivered: () => calls.push('delivered'), end: () => calls.push('end') };
    await expect(withBolusProgress(tracker, { history: async () => [] }, 1, () => 0, async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(calls).toEqual(['begin', 'end']);
  });
});

describe('createBolusGate', () => {
  it('refuses a second bolus while one is running and allows the next one afterwards', async () => {
    const gate = createBolusGate();
    let release: () => void = () => {};
    const first = gate(() => new Promise<string>((r) => (release = () => r('done'))));
    await expect(gate(async () => 'second')).rejects.toThrow('still being delivered');
    release();
    expect(await first).toBe('done');
    expect(await gate(async () => 'third')).toBe('third');
  });

  it('opens again after a failed bolus', async () => {
    const gate = createBolusGate();
    await expect(gate(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await gate(async () => 'ok')).toBe('ok');
  });
});

describe('recordDeliveredBolus', () => {
  it('stores the pump history', async () => {
    const added: InsulinDose[][] = [];
    await recordDeliveredBolus({ addDoses: (d) => void added.push([...d]) }, { history: async () => [dose(2, 1000)] }, 2, 900, () => 2000, 'p');
    expect(added).toEqual([[dose(2, 1000)]]);
  });

  it('keeps a provisional record when the history cannot be read, and does not throw', async () => {
    const added: InsulinDose[][] = [];
    await recordDeliveredBolus({ addDoses: (d) => void added.push([...d]) }, { history: async () => Promise.reject(new Error('link lost')) }, 2, 900, () => 2000, 'p');
    expect(added).toEqual([[{ kind: 'bolus', date: 900, units: 2, id: 'p' }]]);
  });
});
