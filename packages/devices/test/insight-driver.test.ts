import { describe, expect, it } from 'vitest';
import { PUMP_CONTRACT } from '../src/testkit';
import { accuChekInsightPump, isInsightDriver } from '../src/insight';
import { rig } from './insight-helpers';

describe('Insight plugin', () => {
  it('declares the expected metadata', () => {
    expect(accuChekInsightPump.meta).toMatchObject({ id: 'accu-chek-insight', name: 'Accu-Chek Insight', manufacturer: 'Roche', maturity: 'experimental', transport: 'ble' });
  });
});

describe('Insight PUMP_CONTRACT (bridge simulator)', () => {
  for (const check of PUMP_CONTRACT) {
    it(check.name, async () => {
      const r = rig();
      expect(isInsightDriver(r.driver)).toBe(true);
      await check.run(r);
      await r.driver.disconnect();
    });
  }
});
