import { describe, expect, it } from 'vitest';
import type { ActiveTempTarget } from '@buddy/core';
import { fetchedCarbToEntry, resolveDownloadedTempTarget } from '../nightscout-download';

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const tt = (id: string, startedAt: number, durationMin = 60, target = 140): ActiveTempTarget & { enteredBy?: string } => ({ id, name: id, target, durationMin, startedAt });

describe('resolveDownloadedTempTarget', () => {
  it('activates the newest still-running remote temp target', () => {
    const r = resolveDownloadedTempTarget(null, [tt('ns-tt-a', NOW - 50 * MIN), tt('ns-tt-b', NOW - 10 * MIN), tt('ns-tt-old', NOW - 300 * MIN)], [], NOW);
    expect(r?.tempTarget?.id).toBe('ns-tt-b');
  });

  it('ignores expired and scheduled ones', () => {
    expect(resolveDownloadedTempTarget(null, [tt('x', NOW - 120 * MIN, 60), tt('y', NOW + 5 * MIN)], [], NOW)).toBeUndefined();
  });

  it('keeps a local temp target that started later', () => {
    const local = tt('local', NOW - 5 * MIN);
    expect(resolveDownloadedTempTarget(local, [tt('ns-tt-a', NOW - 20 * MIN)], [], NOW)).toBeUndefined();
  });

  it('replaces an older local temp target', () => {
    const local = tt('local', NOW - 30 * MIN);
    expect(resolveDownloadedTempTarget(local, [tt('ns-tt-a', NOW - 5 * MIN)], [], NOW)?.tempTarget?.id).toBe('ns-tt-a');
  });

  it('a cancel after the start ends the running one', () => {
    const local = tt('local', NOW - 30 * MIN);
    expect(resolveDownloadedTempTarget(local, [], [NOW - 10 * MIN], NOW)).toEqual({ tempTarget: null });
  });

  it('a cancel does not end a temp target started after it', () => {
    const local = tt('local', NOW - 5 * MIN);
    expect(resolveDownloadedTempTarget(local, [], [NOW - 10 * MIN], NOW)).toBeUndefined();
  });

  it('a cancelled remote temp target is not activated', () => {
    expect(resolveDownloadedTempTarget(null, [tt('ns-tt-a', NOW - 20 * MIN)], [NOW - 10 * MIN], NOW)).toBeUndefined();
  });

  it('a newer remote one beats a cancel of an older one', () => {
    const local = tt('local', NOW - 40 * MIN);
    const r = resolveDownloadedTempTarget(local, [tt('ns-tt-b', NOW - 5 * MIN)], [NOW - 20 * MIN], NOW);
    expect(r?.tempTarget?.id).toBe('ns-tt-b');
  });

  it('does not strip the id check: same temp target is a no-op and enteredBy is dropped', () => {
    const same = tt('ns-tt-a', NOW - 5 * MIN);
    expect(resolveDownloadedTempTarget(same, [{ ...same, enteredBy: 'x' }], [], NOW)).toBeUndefined();
    const r = resolveDownloadedTempTarget(null, [{ ...same, enteredBy: 'x' }], [], NOW);
    expect(r?.tempTarget).not.toHaveProperty('enteredBy');
  });
});

describe('fetchedCarbToEntry', () => {
  it('maps grams, absorption and note, drops macros and enteredBy', () => {
    expect(fetchedCarbToEntry({ id: 'ns-carb-1', date: 5, grams: 30, fat: 4, absorptionHours: 4, note: 'pasta', enteredBy: 'x' })).toEqual({ id: 'ns-carb-1', date: 5, grams: 30, absorptionHours: 4, note: 'pasta' });
  });
  it('skips entries without carbs', () => {
    expect(fetchedCarbToEntry({ id: 'ns-carb-2', date: 5, grams: 0, fat: 20 })).toBeNull();
  });
});
