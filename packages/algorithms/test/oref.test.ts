import { describe, expect, it } from 'vitest';
import { orefSmb, orefTempBasal, snapshot } from '../src';

describe('oref adapter', () => {
  it('produces Trio-style prediction curves and a reason', () => {
    const d = orefSmb.decide(snapshot({ bg: 180, slope: 4, cob: 40 }), orefSmb.defaultSettings);
    expect(d.reason.length).toBeGreaterThan(10);
    expect(d.predictions?.iob?.length).toBeGreaterThan(10);
    expect(d.predictions?.zt?.length).toBeGreaterThan(10);
    expect(d.eventualGlucose).toBeGreaterThan(100);
    expect(typeof d.debug?.log).toBe('string');
  });

  it('issues SMBs with carbs on board when high', () => {
    const d = orefSmb.decide(snapshot({ bg: 200, slope: 5, cob: 60 }), orefSmb.defaultSettings);
    expect(d.autoBolus ?? 0).toBeGreaterThan(0);
  });

  it('temp-basal flavour never boluses', () => {
    const d = orefTempBasal.decide(snapshot({ bg: 250, slope: 8, cob: 60 }), orefTempBasal.defaultSettings);
    expect(d.autoBolus).toBeUndefined();
    expect(d.tempBasal?.rate ?? 0).toBeGreaterThan(1);
  });
});
