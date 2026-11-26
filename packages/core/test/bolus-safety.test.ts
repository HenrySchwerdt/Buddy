import { describe, expect, it } from 'vitest';
import { describeBolusRejection, MINUTE, totalRecentBolus, validateBolusSafety, type BolusSafetyInput } from '../src';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const base: BolusSafetyInput = { units: 5, maxBolus: 10, maxIOB: 10, currentIOB: 1, recentBoluses: [], now: NOW };
const run = (o: Partial<BolusSafetyInput> = {}) => validateBolusSafety({ ...base, ...o });
const reasonOf = (o: Partial<BolusSafetyInput>) => {
  const r = run(o);
  return r.ok ? 'ok' : r.rejection.reason;
};

describe('validateBolusSafety (Trio BolusSafetyValidatorTests)', () => {
  it('allows a bolus within all limits', () => expect(run()).toEqual({ ok: true }));

  it('rejects above max bolus, allows equal', () => {
    const r = run({ units: 6, maxBolus: 5 });
    expect(r).toMatchObject({ ok: false, rejection: { reason: 'exceedsMaxBolus', maxBolus: 5 } });
    expect(reasonOf({ units: 5, maxBolus: 5, currentIOB: 0 })).toBe('ok');
  });

  it('rejects when IOB is unavailable', () => {
    expect(reasonOf({ units: 1, currentIOB: null })).toBe('iobUnavailable');
    expect(reasonOf({ units: 1, currentIOB: undefined })).toBe('iobUnavailable');
    expect(reasonOf({ units: 1, currentIOB: Number.NaN })).toBe('iobUnavailable');
  });

  it('rejects when IOB + bolus exceeds max IOB, allows equal', () => {
    const r = run({ units: 2.5, maxIOB: 5, currentIOB: 3 });
    expect(r).toMatchObject({ ok: false, rejection: { reason: 'exceedsMaxIOB', currentIOB: 3, maxIOB: 5 } });
    expect(reasonOf({ units: 2, maxIOB: 5, currentIOB: 3 })).toBe('ok');
  });

  it('is robust to float noise at the IOB boundary', () => {
    expect(reasonOf({ units: 0.3, maxIOB: 0.4, currentIOB: 0.1 })).toBe('ok');
  });

  it('rejects when recent boluses total >= 20% of the request, allows below', () => {
    const at = (units: number) => [{ date: NOW - MINUTE, units }];
    const r = run({ units: 5, currentIOB: 0, recentBoluses: at(1) });
    expect(r).toMatchObject({ ok: false, rejection: { reason: 'recentBolusWithinWindow', totalRecent: 1 } });
    expect(reasonOf({ units: 5, currentIOB: 0, recentBoluses: at(0.99) })).toBe('ok');
    expect(reasonOf({ units: 0.3, currentIOB: 0, recentBoluses: at(0.06) })).toBe('recentBolusWithinWindow');
  });

  it('checks max bolus before IOB availability', () => {
    expect(reasonOf({ units: 6, maxBolus: 5, currentIOB: null })).toBe('exceedsMaxBolus');
  });

  it('checks max IOB before recent boluses', () => {
    expect(reasonOf({ units: 5, maxIOB: 5, currentIOB: 3, recentBoluses: [{ date: NOW, units: 4 }] })).toBe('exceedsMaxIOB');
  });

  it('only counts boluses newer than the default 6 minute window (strictly)', () => {
    const edge = NOW - 6 * MINUTE;
    expect(totalRecentBolus([{ date: edge, units: 3 }, { date: edge + 1, units: 2 }], edge)).toBe(2);
    expect(reasonOf({ currentIOB: 0, recentBoluses: [{ date: edge, units: 5 }] })).toBe('ok');
    expect(reasonOf({ currentIOB: 0, recentBoluses: [{ date: edge + 1, units: 5 }] })).toBe('recentBolusWithinWindow');
  });

  it('uses a caller-supplied lookback start (remote command timestamp)', () => {
    const issued = NOW - 20 * MINUTE;
    const recentBoluses = [{ date: NOW - 10 * MINUTE, units: 2 }];
    expect(reasonOf({ currentIOB: 0, recentBoluses })).toBe('ok');
    expect(reasonOf({ currentIOB: 0, recentBoluses, lookbackStart: issued })).toBe('recentBolusWithinWindow');
  });

  it('treats a stale IOB as unavailable only when its age is supplied', () => {
    expect(reasonOf({ iobDate: NOW - 31 * MINUTE })).toBe('iobUnavailable');
    expect(reasonOf({ iobDate: NOW - 29 * MINUTE })).toBe('ok');
    expect(reasonOf({ iobDate: NOW - 10 * MINUTE, maxIobAgeMinutes: 5 })).toBe('iobUnavailable');
  });

  it('fails closed on invalid requests', () => {
    expect(reasonOf({ units: Number.NaN })).toBe('exceedsMaxBolus');
    expect(reasonOf({ units: -1 })).toBe('exceedsMaxBolus');
    expect(reasonOf({ units: 0, currentIOB: 0 })).toBe('recentBolusWithinWindow');
  });
});

describe('rejection messages (Trio wording)', () => {
  it('app wording', () => {
    expect(run({ units: 6, maxBolus: 5 })).toMatchObject({ message: 'The bolus cannot be larger than the pump setting max bolus (5).' });
    expect(run({ currentIOB: null })).toMatchObject({ message: 'Bolus blocked: current IOB is not available.' });
    expect(run({ units: 2.5, maxIOB: 5, currentIOB: 3 })).toMatchObject({
      message: 'Bolus blocked: a 2.5 U bolus would exceed max IOB (5 U). Current IOB: 3 U.',
    });
    expect(run({ currentIOB: 0, recentBoluses: [{ date: NOW, units: 1 }] })).toMatchObject({
      message: 'Bolus blocked: a significant bolus was delivered within the last 6 minutes.',
    });
  });

  it('remote command wording', () => {
    expect(describeBolusRejection({ reason: 'exceedsMaxBolus', maxBolus: 5 }, 6, 'remote')).toBe(
      'Command rejected: bolus amount (6 units) exceeds the maximum allowed (5 units).',
    );
    expect(describeBolusRejection({ reason: 'exceedsMaxIOB', currentIOB: 3, maxIOB: 5 }, 2.5, 'remote')).toBe(
      'Command rejected: bolus amount (2.5 units) would exceed max IOB (5 units). Current IOB: 3 units.',
    );
    expect(describeBolusRejection({ reason: 'iobUnavailable' }, 1, 'remote')).toBe('Command rejected: current IOB is not available.');
  });
});
