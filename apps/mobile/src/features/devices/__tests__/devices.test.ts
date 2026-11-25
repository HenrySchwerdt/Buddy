import { describe, expect, test } from 'vitest';
import type { InsulinDose } from '@buddy/core';
import { BUILT_IN_CGMS, BUILT_IN_PUMPS } from '@buddy/devices';
import { catalogSections, CGM_CATALOG, entryForPlugin, isSupported, PUMP_CATALOG, setupErrors } from '../catalog';
import { bolusMatches, deliveredBolusSince, linkDropBolus, testTempBasalRate } from '../hardware-check-logic';

describe('device catalog', () => {
  test('pump sections follow Trio order with the simulator last', () => {
    expect(catalogSections(PUMP_CATALOG, true).map((s) => s.manufacturer)).toEqual(['Insulet', 'Medtronic', 'Medtrum', 'SOOIL', 'Simulator']);
  });

  test('CGM sections follow Trio order and hide simulators outside dev builds', () => {
    expect(catalogSections(CGM_CATALOG, false).map((s) => s.manufacturer)).toEqual(['Abbott', 'Dexcom', 'Roche', 'Senseonics', 'Syai', 'Other Sources']);
    expect(catalogSections(CGM_CATALOG, true).at(-1)?.manufacturer).toBe('Simulator');
  });

  test('every plugin id in the catalog exists, and every built-in plugin except shadow mode is reachable', () => {
    const ids = new Set([...BUILT_IN_PUMPS, ...BUILT_IN_CGMS].map((p) => p.meta.id));
    const used = new Set([...PUMP_CATALOG, ...CGM_CATALOG].flatMap((e) => e.pluginIds));
    for (const id of used) expect(ids.has(id)).toBe(true);
    expect([...ids].filter((id) => !used.has(id))).toEqual(['nightscout-follower']);
  });

  test('devices without a Buddy driver are listed but not selectable', () => {
    const unsupported = [...PUMP_CATALOG, ...CGM_CATALOG].filter((e) => !isSupported(e)).map((e) => e.name);
    expect(unsupported).toEqual(['Omnipod', 'MiniMed', 'Accu-Chek SmartGuide', 'Eversense', 'Syai Ultra', 'xDrip4iOS']);
  });

  test('Libre 3 / 3+ is selectable and backed by the LibreLinkUp follower', () => {
    const e = CGM_CATALOG.find((c) => c.id === 'LibreLoopCGMManager');
    expect(e?.name).toBe('FreeStyle Libre 3 / 3+ (Beta)');
    expect(e && isSupported(e)).toBe(true);
    expect(entryForPlugin('cgm', 'libre-link-up')?.id).toBe('LibreLoopCGMManager');
  });

  test('entryForPlugin keeps the entry the user picked (G5 vs G6 share a driver)', () => {
    expect(entryForPlugin('cgm', 'dexcom-g6', 'DexG5Transmitter')?.name).toBe('Dexcom G5');
    expect(entryForPlugin('cgm', 'dexcom-g6', null)?.name).toBe('Dexcom G5');
    expect(entryForPlugin('cgm', 'dexcom-g6', 'DexG6Transmitter')?.name).toBe('Dexcom G6 / ONE');
    expect(entryForPlugin('pump', 'nightscout-follower')).toBeNull();
  });

  test('setupErrors validates driver identifiers', () => {
    expect(setupErrors('dana-i', { deviceName: 'ABC12345DE' })).toEqual([]);
    expect(setupErrors('dana-i', { deviceName: 'ABC123' })).toHaveLength(1);
    expect(setupErrors('medtrum-nano', { serialNumber: 'AA76F9D9' })).toEqual([]);
    expect(setupErrors('medtrum-nano', { serialNumber: 'XYZ' })).toHaveLength(1);
    expect(setupErrors('dexcom-g6', { transmitterId: '8G1234' })).toEqual([]);
    expect(setupErrors('nightscout-cgm', { url: 'http://insecure.example' })).toHaveLength(1);
    expect(setupErrors('libre-link-up', { email: 'a@b.c', password: 'x' })).toEqual([]);
    expect(setupErrors('libre-link-up', { email: 'a@b.c', password: '' })).toHaveLength(1);
    expect(setupErrors('demo-pump', {})).toEqual([]);
  });
});

describe('hardware check logic', () => {
  test('test temp basal is half the scheduled rate on the increment grid, capped by max basal', () => {
    expect(testTempBasalRate(1, 5, 0.05)).toBe(0.5);
    expect(testTempBasalRate(0.05, 5, 0.05)).toBe(0.05);
    expect(testTempBasalRate(4, 1, 0.1)).toBe(1);
  });

  test('link-drop bolus stays within max bolus', () => {
    expect(linkDropBolus(10, 0.05)).toBe(0.5);
    expect(linkDropBolus(0.3, 0.05)).toBe(0.3);
  });

  test('delivered bolus counts boluses and SMBs since a time only', () => {
    const history: InsulinDose[] = [
      { kind: 'bolus', date: 1_000, units: 1, id: 'a' },
      { kind: 'bolus', date: 5_000, units: 0.1, id: 'b' },
      { kind: 'smb', date: 6_000, units: 0.2, id: 'c' },
      { kind: 'tempBasal', date: 6_000, rate: 1, durationMin: 30, id: 'd' },
    ];
    expect(deliveredBolusSince(history, 2_000)).toBe(0.3);
  });

  test('bolus comparison tolerates half an increment', () => {
    expect(bolusMatches(0.1, 0.1, 0.05)).toBe(true);
    expect(bolusMatches(0.15, 0.1, 0.05)).toBe(false);
  });
});
