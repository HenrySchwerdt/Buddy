import { describe, expect, it } from 'vitest';
import { formatCrc, loadStoredCalibrations, parseStoredCalibration } from '../stored';

const full = { i1: 1, i2: 2, i3: 3, i4: 4, i5: 5, i6: 6, extraSlope: 1.1, extraOffset: -2, isValidForFooterWithReverseCRCs: 0xabc };

describe('parseStoredCalibration', () => {
  it('reads a full record', () => {
    expect(parseStoredCalibration(JSON.stringify(full))).toEqual(full);
  });
  it('defaults extra slope and offset together', () => {
    expect(parseStoredCalibration(JSON.stringify({ ...full, extraOffset: undefined }))).toMatchObject({ extraSlope: 1, extraOffset: 0 });
  });
  it('rejects incomplete, malformed and empty input', () => {
    expect(parseStoredCalibration(JSON.stringify({ ...full, i3: 'x' }))).toBeNull();
    expect(parseStoredCalibration('{nope')).toBeNull();
    expect(parseStoredCalibration('42')).toBeNull();
    expect(parseStoredCalibration(null)).toBeNull();
  });
});

describe('loadStoredCalibrations', () => {
  it('maps both sources and tolerates storage failures', async () => {
    const out = await loadStoredCalibrations(async (k) => {
      if (k.includes('transmitter')) throw new Error('keychain locked');
      return JSON.stringify(full);
    });
    expect(out.map((o) => o.info !== null)).toEqual([true, false]);
  });
});

describe('formatCrc', () => {
  it('pads to four hex digits', () => {
    expect(formatCrc(0xabc)).toBe('0ABC');
  });
});
