import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, normalizeSettings, silentLogger, validateSettings, type DeviceContext } from '@buddy/core';
import { createFakeBle } from '../src/testkit';
import { accuChekInsightPump, INSIGHT_DEFAULTS, INSIGHT_SETTINGS } from '../src/insight';
import { START } from './insight-helpers';

const ctx = (over: Partial<DeviceContext> = {}): DeviceContext => ({ clock: { now: () => START }, log: silentLogger, fetch, ble: createFakeBle().transport, secrets: createMemorySecretStore(), ...over });

describe('Insight plugin settings', () => {
  it('validates with its defaults and keeps the pairing key a secret field', () => {
    expect(validateSettings(INSIGHT_SETTINGS, INSIGHT_DEFAULTS)).toEqual([]);
    const fields = INSIGHT_SETTINGS.flatMap((s) => s.fields);
    expect(fields.filter((f) => f.kind === 'text' && f.secret).map((f) => f.key)).toEqual(['pairingSecret']);
    expect(Object.keys(INSIGHT_DEFAULTS).sort()).toEqual(fields.map((f) => f.key).sort());
    expect(normalizeSettings(INSIGHT_SETTINGS, INSIGHT_DEFAULTS, { maxBolus: 99 }).maxBolus).toBe(25);
    expect(validateSettings(INSIGHT_SETTINGS, { ...INSIGHT_DEFAULTS, maxBolus: 0 })).not.toEqual([]);
  });

  it('flags the dosing limits as affecting dosing', () => {
    const limits = INSIGHT_SETTINGS.flatMap((s) => s.fields).filter((f) => f.key === 'maxBolus' || f.key === 'maxBasal');
    expect(limits.every((f) => f.kind === 'number' && f.affectsDosing === true)).toBe(true);
  });

  it('refuses to build a driver before a bridge is paired or without Bluetooth', () => {
    expect(() => accuChekInsightPump.create(INSIGHT_DEFAULTS, ctx())).toThrow(/paired/i);
    const { ble: _ble, ...noBle } = ctx();
    void _ble;
    expect(() => accuChekInsightPump.create({ ...INSIGHT_DEFAULTS, bridgeId: 'fedcba9876543210' }, noBle)).toThrow(/Bluetooth/);
  });

  it('builds a driver for a paired bridge', () => {
    const driver = accuChekInsightPump.create({ ...INSIGHT_DEFAULTS, bridgeId: 'FEDCBA9876543210', basalProfile: '1.0' }, ctx());
    expect(driver.meta.id).toBe('accu-chek-insight');
  });
});
