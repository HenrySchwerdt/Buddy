import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The iOS background setup the heartbeat design depends on lives in app.json plugins; a change there silently
 * stops the app from being woken by Bluetooth, so it is pinned here.
 */
const appJson = JSON.parse(readFileSync(new URL('../../../app.json', import.meta.url), 'utf8')) as { expo: { plugins: (string | [string, Record<string, unknown>])[] } };
const pluginConfig = (name: string) => appJson.expo.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);

describe('app.json background configuration', () => {
  it('keeps the bluetooth-central background mode (react-native-ble-plx, background enabled, central role)', () => {
    const plugin = pluginConfig('react-native-ble-plx');
    expect(Array.isArray(plugin)).toBe(true);
    const config = (plugin as [string, { isBackgroundEnabled?: boolean; modes?: string[] }])[1];
    expect(config.isBackgroundEnabled).toBe(true);
    expect(config.modes).toContain('central');
  });

  it('keeps the background task plugin (processing / fetch modes and the BGTaskScheduler identifier)', () => {
    expect(pluginConfig('expo-background-task')).toBeDefined();
  });
});
