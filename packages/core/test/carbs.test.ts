import { afterEach, describe, expect, it } from 'vitest';
import { carbsOnBoard, HOUR, setMaxAbsorptionHours } from '../src';

const T0 = Date.UTC(2026, 10, 26, 12);

describe('maximum absorption time', () => {
  afterEach(() => setMaxAbsorptionHours(Infinity));

  it('leaves entries alone without a limit', () => {
    expect(carbsOnBoard([{ id: 'a', date: T0, grams: 60, absorptionHours: 8 }], T0 + 4 * HOUR)).toBeCloseTo(30);
  });

  it('shortens entries that would absorb for longer than the limit', () => {
    setMaxAbsorptionHours(4);
    // 8 h entry capped to 4 h: fully absorbed after 4 h.
    expect(carbsOnBoard([{ id: 'a', date: T0, grams: 60, absorptionHours: 8 }], T0 + 4 * HOUR)).toBeCloseTo(0);
  });

  it('does not lengthen shorter entries', () => {
    setMaxAbsorptionHours(6);
    expect(carbsOnBoard([{ id: 'a', date: T0, grams: 60 }], T0 + 3 * HOUR)).toBeCloseTo(0);
  });

  it('ignores invalid limits', () => {
    setMaxAbsorptionHours(0);
    setMaxAbsorptionHours(Number.NaN);
    expect(carbsOnBoard([{ id: 'a', date: T0, grams: 60, absorptionHours: 6 }], T0 + 3 * HOUR)).toBeCloseTo(30);
  });
});
