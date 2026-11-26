import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BUILT_IN_CGMS, BUILT_IN_PUMPS } from '@buddy/devices';
import { catalogSections, CGM_CATALOG, DEVICE_IMAGE_KEYS, entryForPlugin, isSupported, PUMP_CATALOG, setupErrors } from '../catalog';

describe('device catalog', () => {
  test('pump sections follow Trio order with the simulator last', () => {
    expect(catalogSections(PUMP_CATALOG, true).map((s) => s.manufacturer)).toEqual(['Insulet', 'Medtronic', 'Medtrum', 'Roche', 'SOOIL', 'Simulator']);
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
    expect(unsupported).toEqual(['Accu-Chek SmartGuide', 'Eversense']);
  });

  test('Libre 3 / 3+ is selectable and backed by the LibreLinkUp follower', () => {
    const e = CGM_CATALOG.find((c) => c.id === 'LibreLoopCGMManager');
    expect(e?.name).toBe('FreeStyle Libre 3 / 3+ (cloud)');
    expect(e && isSupported(e)).toBe(true);
    expect(entryForPlugin('cgm', 'libre-link-up')?.id).toBe('LibreLoopCGMManager');
  });

  test('Libre 3 direct, Syai Ultra and Omnipod DASH are backed by their drivers', () => {
    expect(entryForPlugin('cgm', 'libre-3-direct')?.id).toBe('LibreLoopDirect');
    expect(entryForPlugin('cgm', 'syai-ultra')?.id).toBe('SyaiCGMManager');
    expect(entryForPlugin('pump', 'omnipod-dash')?.id).toBe('Omni');
    expect(entryForPlugin('pump', 'omnipod-eros')?.id).toBe('OmniEros');
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

describe('device artwork', () => {
  const devicesDir = join(__dirname, '..');
  const iconSource = readFileSync(join(devicesDir, 'device-icon.tsx'), 'utf8');
  const mapped = [...iconSource.matchAll(/^\s+'?([a-z0-9-]+)'?: require\('\.\/images\/([a-z0-9-]+\.png)'\)/gm)].map((m) => ({ key: m[1], file: m[2] }));

  test('every catalog entry has an image', () => {
    const missing = [...PUMP_CATALOG, ...CGM_CATALOG].filter((e) => e.image === null).map((e) => e.name);
    expect(missing).toEqual([]);
  });

  test('every catalog image key is a known DeviceImage key', () => {
    for (const e of [...PUMP_CATALOG, ...CGM_CATALOG]) expect(DEVICE_IMAGE_KEYS).toContain(e.image);
  });

  test('DEVICE_IMAGES has exactly one existing PNG per DeviceImage key', () => {
    expect(mapped.map((m) => m.key).sort()).toEqual([...DEVICE_IMAGE_KEYS].sort());
    for (const m of mapped) expect(existsSync(join(devicesDir, 'images', m.file)), m.file).toBe(true);
  });

  test('drawn artwork keeps its SVG source next to the PNG', () => {
    const drawn = ['minimed', 'insight', 'eversense', 'accu-chek', 'libre', 'libre-3', 'dexcom-share', 'xdrip', 'nightscout'];
    for (const name of drawn) expect(existsSync(join(devicesDir, 'images', 'src', `${name}.svg`)), name).toBe(true);
  });
});

