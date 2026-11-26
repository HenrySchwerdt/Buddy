import type { Millis, OverridePreset, Schedule, TherapyProfile } from '@buddy/core';
import { ENTERED_BY, isoDate, round } from './format';
import type { NightscoutPresetOverride, NightscoutProfileStore, NightscoutScheduledProfile, NightscoutTimevalue } from './types';

/** Trio's `GlucoseUnits.exchangeRate`. */
const MMOL_PER_MGDL = 0.0555;
const DEFAULT_PROFILE = 'default';
/** Trio's `Preferences.min5mCarbimpact` default (mg/dL per 5 min). */
export const DEFAULT_MIN_5M_CARB_IMPACT = 8;

export interface ProfileUploadInput {
  readonly profile: TherapyProfile;
  /** Display units; Nightscout then shows glucose values in them (`mg/dl` or `mmol`). */
  readonly units: 'mg/dL' | 'mmol/L';
  /** IANA timezone id, e.g. `Europe/Berlin`. */
  readonly timezone: string;
  readonly now: Millis;
  /** Preference `min_5m_carbimpact`; only used for `carbs_hr`. */
  readonly min5mCarbImpact?: number;
  /** Presets advertised to followers (remote override start). */
  readonly overridePresets?: readonly OverridePreset[];
  /** Remote-control fields; Buddy has none yet, so these default to empty like a build without them. */
  readonly bundleIdentifier?: string;
  readonly deviceToken?: string;
  readonly isAPNSProduction?: boolean;
  readonly teamID?: string;
  readonly expirationDate?: Millis;
  readonly remoteCommands?: readonly string[];
}

const hhmm = (startMinute: number): string => `${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}`;

function rows<T>(schedule: Schedule<T>, value: (v: T) => number): NightscoutTimevalue[] {
  return schedule.map((e) => ({ time: hhmm(e.startMinute), value: value(e.value), timeAsSeconds: e.startMinute * 60 }));
}

/** Trio's `asMmolL`: x 0.0555, one decimal. */
export const asMmolL = (mgdl: number): number => round(mgdl * MMOL_PER_MGDL, 1);

/** Carbs absorbed per hour, from the first ISF/CR like Trio: min5m * 12 / isf * cr, 1 decimal, then truncated. */
function carbsPerHour(profile: TherapyProfile, min5m: number): number {
  const isf = profile.isf[0]?.value;
  const cr = profile.carbRatio[0]?.value;
  if (isf === undefined || cr === undefined || !(isf > 0) || !(cr > 0)) return 0;
  return Math.trunc(round((min5m * 12 * cr) / isf, 1));
}

/**
 * Builds the profile-store document Trio POSTs to `api/v1/profile.json`: one `default` profile with
 * basal, ISF, carb ratio and targets, plus override presets. Glucose values follow the display
 * units, the ISF-based `carbs_hr` always uses mg/dL like Trio.
 */
export function mapProfileToStore(input: ProfileUploadInput): NightscoutProfileStore {
  const { profile } = input;
  const mmol = input.units === 'mmol/L';
  const glucose = (v: number): number => (mmol ? asMmolL(v) : v);
  const units = mmol ? 'mmol' : 'mg/dl';

  const scheduled: NightscoutScheduledProfile = {
    dia: profile.diaHours,
    carbs_hr: carbsPerHour(profile, input.min5mCarbImpact ?? DEFAULT_MIN_5M_CARB_IMPACT),
    delay: 0,
    timezone: input.timezone,
    target_low: rows(profile.target, (t) => glucose(t.low)),
    target_high: rows(profile.target, (t) => glucose(t.high)),
    sens: rows(profile.isf, glucose),
    basal: rows(profile.basal, (v) => v),
    carbratio: rows(profile.carbRatio, (v) => v),
    units,
  };

  const presets: NightscoutPresetOverride[] = (input.overridePresets ?? []).map((o) => ({
    name: o.name,
    ...(o.durationMin ? { duration: o.durationMin } : {}),
    ...(o.percentage ? { percentage: o.percentage } : {}),
    ...(o.target ? { target: glucose(o.target) } : {}),
  }));

  return {
    defaultProfile: DEFAULT_PROFILE,
    startDate: isoDate(input.now),
    mills: Math.floor(input.now / 1000) * 1000,
    units,
    enteredBy: ENTERED_BY,
    store: { [DEFAULT_PROFILE]: scheduled },
    bundleIdentifier: input.bundleIdentifier ?? '',
    deviceToken: input.deviceToken ?? '',
    isAPNSProduction: input.isAPNSProduction ?? false,
    overridePresets: presets,
    teamID: input.teamID ?? '',
    ...(input.expirationDate !== undefined ? { expirationDate: isoDate(input.expirationDate) } : {}),
    remoteCommands: input.remoteCommands ?? [],
  };
}
