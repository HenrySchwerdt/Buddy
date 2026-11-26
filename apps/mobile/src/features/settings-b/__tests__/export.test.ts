import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE } from '@buddy/core';
import type { AppSettings } from '@/runtime/settings-store';
import { AVAILABLE_CATEGORIES, buildSettingsExport, EXPORT_CATEGORIES, profilesForExport, type ExportExtras } from '../export';

const meta = { appVersion: '0.1.0', exportedAt: '2026-11-26T10:00:00.000Z' };
const settings = { units: 'mg/dL', profile: DEFAULT_PROFILE, pumpId: 'p', cgmId: 'c', deviceSettings: {}, overridePresets: [], tempTargetPresets: [], alerts: {} } as unknown as AppSettings;
const live = { ...DEFAULT_PROFILE, basal: [{ startMinute: 0, value: 0.9 }] };
const extras: ExportExtras = {
  mealPresets: [
    { id: 'b', dish: 'Pizza', carbs: 60, fat: 30, protein: 25 },
    { id: 'a', dish: 'Apple', carbs: 15, fat: 0, protein: 0 },
  ],
  profiles: {
    activeName: 'Default',
    stored: [{ name: 'Sick day', basal: [{ startMinute: 0, value: 1.2 }], isf: DEFAULT_PROFILE.isf, carbRatio: DEFAULT_PROFILE.carbRatio, target: DEFAULT_PROFILE.target }],
    live,
  },
};

describe('settings export', () => {
  it('offers every Trio category', () => {
    expect(AVAILABLE_CATEGORIES).toEqual(EXPORT_CATEGORIES);
  });

  it('exports meal presets sorted by dish without internal ids', () => {
    const out = JSON.parse(buildSettingsExport(settings, new Set(['Meal Presets']), meta, extras));
    expect(out['Meal Presets'].mealPresets).toEqual([
      { dish: 'Apple', carbs: 15, fat: 0, protein: 0 },
      { dish: 'Pizza', carbs: 60, fat: 30, protein: 25 },
    ]);
  });

  it('exports therapy profiles with Default first and the active one taken from the live schedules', () => {
    const out = JSON.parse(buildSettingsExport(settings, new Set(['Therapy Profiles']), meta, extras));
    const section = out['Therapy Profiles'];
    expect(section.activeProfile).toBe('Default');
    expect(section.profiles.map((p: { name: string }) => p.name)).toEqual(['Default', 'Sick day']);
    expect(section.profiles[0].basal).toEqual([{ startMinute: 0, value: 0.9 }]);
    expect(section.profiles[1].basal).toEqual([{ startMinute: 0, value: 1.2 }]);
  });

  it('only includes the selected categories', () => {
    const out = JSON.parse(buildSettingsExport(settings, new Set(['Meal Presets']), meta, extras));
    expect(Object.keys(out)).toEqual(['Meal Presets']);
  });

  it('strips secret-looking keys from every section', () => {
    const withSecret = { ...settings, deviceSettings: { x: { apiToken: 'abc', host: 'h' } } } as AppSettings;
    const json = buildSettingsExport(withSecret, new Set(['Devices']), meta, extras);
    expect(json).not.toContain('abc');
    expect(json).toContain('"host"');
  });

  it('keeps stored profiles without a Default entry listing it first', () => {
    expect(profilesForExport({ ...extras.profiles, activeName: 'Sick day' }).map((p) => p.name)).toEqual(['Default', 'Sick day']);
  });
});
