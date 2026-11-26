import type { TherapyProfile } from '@buddy/core';
import type { MealPreset } from '@/features/treatment/presets-store';
import type { ProfileSchedules, StoredProfile } from '@/features/settings/profiles';
import type { AppSettings } from '@/runtime/settings-store';

/**
 * Settings export (Trio SettingsExport). Trio's category list is kept in order; categories
 * Buddy has no data for are listed as unavailable. Secrets never live in AppSettings (the
 * Nightscout token and device secrets are in SecureStore), and keys that look secret are
 * stripped anyway as a second line of defence.
 */

export const EXPORT_CATEGORIES = [
  'Metadata',
  'Devices',
  'Therapy',
  'Therapy Profiles',
  'Algorithm',
  'Features',
  'Notifications',
  'Services',
  'Temp Target Presets',
  'Override Presets',
  'Meal Presets',
] as const;

export type ExportCategory = (typeof EXPORT_CATEGORIES)[number];

/** Categories without a Buddy counterpart (none: every Trio category is exportable). */
export const UNAVAILABLE_CATEGORIES: ReadonlySet<ExportCategory> = new Set();

export const AVAILABLE_CATEGORIES = EXPORT_CATEGORIES.filter((c) => !UNAVAILABLE_CATEGORIES.has(c));

const SECRET_KEY = /token|secret|password|passcode|apikey|api_key/i;

/** Deep copy without secret-looking keys. */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEY.test(k))
        .map(([k, v]) => [k, stripSecrets(v)]),
    );
  }
  return value;
}

type Section = Record<string, unknown>;

/** Data that lives outside AppSettings (their own stores). */
export interface ExportExtras {
  readonly mealPresets: readonly MealPreset[];
  readonly profiles: { readonly activeName: string; readonly stored: readonly StoredProfile[]; readonly live: TherapyProfile };
}

export const EMPTY_EXTRAS: ExportExtras = { mealPresets: [], profiles: { activeName: 'Default', stored: [], live: { basal: [], isf: [], carbRatio: [], target: [], diaHours: 0, insulinCurve: 'rapid-acting' } } };

const schedules = (p: ProfileSchedules): ProfileSchedules => ({ basal: p.basal, isf: p.isf, carbRatio: p.carbRatio, target: p.target });

/** All named profiles, Default first, the active one showing the live schedules (as the Therapy Profiles screen lists them). */
export function profilesForExport(x: ExportExtras['profiles']): StoredProfile[] {
  const live = schedules(x.live);
  const list = x.stored.some((p) => p.name === 'Default') ? [...x.stored] : [{ name: 'Default', ...live }, ...x.stored];
  return list.map((p) => (p.name === x.activeName ? { ...p, ...live } : p));
}

function sectionFor(category: ExportCategory, s: AppSettings, meta: { appVersion: string; exportedAt: string }, extras: ExportExtras): Section | null {
  switch (category) {
    case 'Metadata':
      return { app: 'Buddy', appVersion: meta.appVersion, exportedAt: meta.exportedAt, format: 'buddy.settings-export.v1' };
    case 'Devices':
      return { pumpId: s.pumpId, cgmId: s.cgmId, deviceSettings: s.deviceSettings };
    case 'Therapy':
      return { units: s.units, profile: s.profile, limits: s.limits };
    case 'Algorithm':
      return { loopMode: s.loopMode, algorithmId: s.algorithmId, algorithmSettings: s.algorithmSettings };
    case 'Features':
      return { appearance: s.appearance, bolusFraction: s.bolusFraction };
    case 'Notifications':
      return { alerts: s.alerts };
    case 'Services':
      return { nightscout: { url: s.nightscoutUrl, upload: s.nightscoutUpload } };
    case 'Temp Target Presets':
      return { tempTargetPresets: s.tempTargetPresets };
    case 'Therapy Profiles':
      return { activeProfile: extras.profiles.activeName, profiles: profilesForExport(extras.profiles) };
    case 'Override Presets':
      return { overridePresets: s.overridePresets };
    case 'Meal Presets':
      return { mealPresets: [...extras.mealPresets].sort((a, b) => a.dish.localeCompare(b.dish)).map(({ dish, carbs, fat, protein }) => ({ dish, carbs, fat, protein })) };
    default:
      return null;
  }
}

/** Builds the export JSON for the selected categories (live state like snoozes is excluded). */
export function buildSettingsExport(s: AppSettings, selected: ReadonlySet<ExportCategory>, meta: { appVersion: string; exportedAt: string }, extras: ExportExtras = EMPTY_EXTRAS): string {
  const out: Record<string, Section> = {};
  for (const category of EXPORT_CATEGORIES) {
    if (!selected.has(category)) continue;
    const section = sectionFor(category, s, meta, extras);
    if (section) out[category] = stripSecrets(section) as Section;
  }
  return JSON.stringify(out, null, 2);
}
