import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, DEFAULT_PROFILE, type InsulinDose } from '@buddy/core';
import { checkBolusSafety } from '../bolus-safety';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const limits = { ...DEFAULT_LIMITS, maxBolus: 10, maxIOB: 8 };
const bolus = (units: number, minutesAgo: number, kind: 'bolus' | 'smb' = 'bolus'): InsulinDose => ({ kind, units, date: NOW - minutesAgo * MIN, id: `b-${units}-${minutesAgo}` });
const run = (units: number, doses: InsulinDose[] = [], extra: object = {}) => checkBolusSafety({ units, limits, profile: DEFAULT_PROFILE, doses, now: NOW, ...extra });

describe('checkBolusSafety', () => {
  it('allows a normal bolus', () => {
    expect(run(2).ok).toBe(true);
  });

  it('rejects above max bolus', () => {
    const r = run(11);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.reason).toBe('exceedsMaxBolus');
  });

  it('rejects when the bolus would exceed max IOB', () => {
    const r = run(4, [bolus(5, 30)]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.reason).toBe('exceedsMaxIOB');
      expect(r.message).toMatch(/max IOB/);
    }
  });

  it('rejects when a significant bolus (even an SMB) was delivered in the last 6 minutes', () => {
    const r = run(2, [bolus(0.5, 3, 'smb')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.reason).toBe('recentBolusWithinWindow');
  });

  it('ignores a small recent bolus and older boluses', () => {
    expect(run(5, [bolus(0.5, 3)]).ok).toBe(true);
    expect(run(2, [bolus(2, 20)]).ok).toBe(true);
  });

  it('uses the command timestamp as lookback for remote commands', () => {
    const r = run(2, [bolus(1, 9)], { source: 'remote', lookbackStart: NOW - 10 * MIN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^Command rejected/);
  });
});
