import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '@buddy/core';
import { orefSmb } from '../src/oref/plugins';

describe('oref settings schema', () => {
  it('lets the user change the SMB temp-target and max-delta settings', () => {
    // Arrange
    const values = { enableSMBWithTempTarget: true, allowSMBWithHighTempTarget: true, maxDeltaBGThreshold: 0.3 };

    // Act
    const s = normalizeSettings(orefSmb.settings, orefSmb.defaultSettings, values);

    // Assert
    expect(s.enableSMBWithTempTarget).toBe(true);
    expect(s.allowSMBWithHighTempTarget).toBe(true);
    expect(s.maxDeltaBGThreshold).toBe(0.3);
  });

  it('clamps max delta threshold to the Trio range', () => {
    const s = normalizeSettings(orefSmb.settings, orefSmb.defaultSettings, { maxDeltaBGThreshold: 0.9 });
    expect(s.maxDeltaBGThreshold).toBeLessThanOrEqual(0.4);
  });
});
