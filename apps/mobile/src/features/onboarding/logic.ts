/**
 * Pure onboarding logic ported from Trio's `Onboarding.StateModel` (+Nightscout), `DecimalPickerSettings`
 * and `DeviceCatalog`: picker grids, pump basal capabilities, schedule validation, Max IOB seeding,
 * Nightscout profile mapping and the final mapping onto Buddy's settings.
 */
import { formatGlucose, type GlucoseUnit, type SafetyLimits, type SettingsValues, type TherapyProfile } from '@buddy/core';
import { parseNightscoutProfile } from '@buddy/devices';

// MARK: Picker settings (Trio `PickerSetting` / `DecimalPickerSettings`)

export type PickerKind = 'glucose' | 'factor' | 'gram' | 'insulinUnit' | 'insulinUnitPerHour' | 'minute';
export interface PickerSetting {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly kind: PickerKind;
}

export const PICKERS = {
  maxIOB: { min: 0, max: 30, step: 1, kind: 'insulinUnit' },
  maxBolus: { min: 0.5, max: 30, step: 0.5, kind: 'insulinUnit' },
  maxBasal: { min: 0.5, max: 30, step: 0.5, kind: 'insulinUnitPerHour' },
  maxCOB: { min: 0, max: 300, step: 5, kind: 'gram' },
  thresholdSetting: { min: 60, max: 120, step: 1, kind: 'glucose' },
  autosensMin: { min: 0.5, max: 1, step: 0.05, kind: 'factor' },
  autosensMax: { min: 0.5, max: 2, step: 0.05, kind: 'factor' },
  highGlucoseTarget: { min: 70, max: 200, step: 1, kind: 'glucose' },
  maxSMBMinutes: { min: 15, max: 180, step: 5, kind: 'minute' },
  maxUAMMinutes: { min: 15, max: 180, step: 5, kind: 'minute' },
  maxDeltaGlucoseThreshold: { min: 0.1, max: 0.4, step: 0.05, kind: 'factor' },
  halfBasalTarget: { min: 105, max: 300, step: 5, kind: 'glucose' },
  target: { min: 72, max: 180, step: 1, kind: 'glucose' },
  isf: { min: 9, max: 540, step: 1, kind: 'glucose' },
  carbRatio: { min: 1, max: 50, step: 0.1, kind: 'gram' },
} as const satisfies Record<string, PickerSetting>;

export const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** `PickerSettingsProvider.generatePickerValues`: glucose values stay mg/dL; for mmol/L duplicates after rounding to 0.1 are dropped. */
export function pickerValues(s: PickerSetting, units: GlucoseUnit): number[] {
  const count = Math.round((s.max - s.min) / s.step);
  const values = Array.from({ length: count + 1 }, (_, i) => round4(s.min + i * s.step));
  if (units !== 'mmol/L' || s.kind !== 'glucose') return values;
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = formatGlucose(v, 'mmol/L');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function closest(value: number, options: readonly number[]): number {
  let best = options[0] ?? value;
  for (const o of options) if (Math.abs(o - value) < Math.abs(best - value)) best = o;
  return best;
}

// MARK: Pump models (Trio `DeviceCatalog.onboardingPumps`)

export interface PumpModel {
  readonly id: string;
  readonly name: string;
  readonly basal: { readonly min: number; readonly max: number; readonly step: number };
  readonly reportsRewindEvents: boolean;
}

/** Basal grids from each kit's `onboardingSupportedBasalRates`, zero dropped (oref rejects a 0 U/h schedule). */
export const PUMP_MODELS: readonly PumpModel[] = [
  { id: 'Omni', name: 'Omnipod', basal: { min: 0.05, max: 30, step: 0.05 }, reportsRewindEvents: false },
  { id: 'Minimed500', name: 'MiniMed', basal: { min: 0.05, max: 35, step: 0.05 }, reportsRewindEvents: true },
  { id: 'Medtrum', name: 'Medtrum Nano', basal: { min: 0.05, max: 30, step: 0.05 }, reportsRewindEvents: false },
  { id: 'Dana', name: 'Dana', basal: { min: 0.01, max: 3, step: 0.01 }, reportsRewindEvents: true },
];
export const DEFAULT_PUMP_MODEL = PUMP_MODELS[0]!;
export const pumpModel = (id: string | null | undefined): PumpModel => PUMP_MODELS.find((p) => p.id === id) ?? DEFAULT_PUMP_MODEL;
export const basalPicker = (p: PumpModel): PickerSetting => ({ ...p.basal, kind: 'insulinUnitPerHour' });

// MARK: Therapy schedules (Trio `TherapySettingItem`)

export interface TherapyItem {
  readonly id: string;
  /** Seconds after midnight. */
  readonly time: number;
  readonly value: number;
}

export const DAY_SECONDS = 86_400;
export const HALF_HOUR = 1_800;
export const LAST_SLOT = DAY_SECONDS - HALF_HOUR;
export const MAX_ENTRIES = 48;
export const TIME_VALUES: readonly number[] = Array.from({ length: DAY_SECONDS / HALF_HOUR }, (_, i) => i * HALF_HOUR);

let idCounter = 0;
export const newItem = (time: number, value: number): TherapyItem => ({ id: `ti-${++idCounter}`, time, value });

/** Removes duplicate times, sorts by time and forces the first entry to 00:00 (`validated(items:)`). */
export function validateItems(items: readonly TherapyItem[]): TherapyItem[] {
  const byTime = new Map<number, TherapyItem>();
  for (const item of items) if (!byTime.has(item.time)) byTime.set(item.time, item);
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  return sorted.map((item, i) => (i === 0 && item.time !== 0 ? { ...item, time: 0 } : item));
}

/** Snaps values and times to the available grids (`updateX(from:)` / remap on unit or pump change). */
export const snapItems = (items: readonly TherapyItem[], options: readonly number[]): TherapyItem[] =>
  validateItems(items.map((i) => ({ ...i, time: closest(i.time, TIME_VALUES), value: closest(i.value, options) })));

/** Editor "Add": next half hour after the last entry (max 23:30), same value. */
export function addItem(items: readonly TherapyItem[]): TherapyItem[] {
  const last = items[items.length - 1];
  return [...items, newItem(Math.min((last?.time ?? 0) + HALF_HOUR, LAST_SLOT), last?.value ?? 1)];
}

export const cannotAddMore = (items: readonly TherapyItem[]) => items.length >= MAX_ENTRIES || (items[items.length - 1]?.time ?? 0) >= LAST_SLOT;

/** Total insulin a basal schedule delivers over 24 h. */
export function totalDailyBasal(items: readonly TherapyItem[]): number {
  const sorted = [...items].sort((a, b) => a.time - b.time);
  return round4(sorted.reduce((sum, item, i) => sum + (item.value * ((sorted[i + 1]?.time ?? DAY_SECONDS) - item.time)) / 3600, 0));
}

/** Starting Max IOB for a new user: a third of the total daily basal, snapped to the picker step and clamped. */
export function suggestedMaxIOB(tdb: number, s: PickerSetting = PICKERS.maxIOB): number {
  const snapped = s.step > 0 ? Math.round(tdb / 3 / s.step) * s.step : tdb / 3;
  return round4(Math.min(s.max, Math.max(s.min, snapped)));
}

// MARK: Formatting

export const fmtNumber = (v: number) => String(round4(v));
/** Basal list format: 2–3 fraction digits. */
export const fmtBasal = (v: number) => {
  const s = v.toFixed(3);
  return s.endsWith('0') ? v.toFixed(2) : s;
};
export const fmtPercent = (v: number) => `${Math.round(v * 100)}%`;
export const fmtClock = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
export const glucoseValue = (mgdl: number, units: GlucoseUnit) => formatGlucose(mgdl, units);
export const glucoseWithUnits = (mgdl: number, units: GlucoseUnit) => `${formatGlucose(mgdl, units)} ${units}`;

// MARK: Draft → Buddy settings

export interface OnboardingDraft {
  readonly units: GlucoseUnit;
  readonly pumpModelId: string;
  readonly targets: readonly TherapyItem[];
  readonly basal: readonly TherapyItem[];
  readonly carbRatios: readonly TherapyItem[];
  readonly isf: readonly TherapyItem[];
  readonly maxIOB: number;
  readonly maxBolus: number;
  readonly maxBasal: number;
  readonly maxCOB: number;
  readonly minimumSafetyThreshold: number;
  readonly autosensMin: number;
  readonly autosensMax: number;
  readonly rewindResetsAutosens: boolean;
  readonly enableSMBAlways: boolean;
  readonly enableSMBWithCOB: boolean;
  readonly enableSMBWithTempTarget: boolean;
  readonly enableSMBAfterCarbs: boolean;
  readonly enableSMBWithHighGlucoseTarget: boolean;
  readonly highGlucoseTarget: number;
  readonly allowSMBWithHighTempTarget: boolean;
  readonly enableUAM: boolean;
  readonly maxSMBMinutes: number;
  readonly maxUAMMinutes: number;
  readonly maxDeltaGlucoseThreshold: number;
  readonly highTempTargetRaisesSensitivity: boolean;
  readonly lowTempTargetLowersSensitivity: boolean;
  readonly sensitivityRaisesTarget: boolean;
  readonly resistanceLowersTarget: boolean;
  readonly halfBasalTarget: number;
}

/** Trio's StateModel defaults. Schedules start empty and are seeded when their step first appears. */
export const DEFAULT_DRAFT: OnboardingDraft = {
  units: 'mg/dL',
  pumpModelId: DEFAULT_PUMP_MODEL.id,
  targets: [],
  basal: [],
  carbRatios: [],
  isf: [],
  maxIOB: 0,
  maxBolus: 10,
  maxBasal: 2,
  maxCOB: 120,
  minimumSafetyThreshold: 60,
  autosensMin: 0.7,
  autosensMax: 1.2,
  rewindResetsAutosens: true,
  enableSMBAlways: false,
  enableSMBWithCOB: false,
  enableSMBWithTempTarget: false,
  enableSMBAfterCarbs: false,
  enableSMBWithHighGlucoseTarget: false,
  highGlucoseTarget: 110,
  allowSMBWithHighTempTarget: false,
  enableUAM: false,
  maxSMBMinutes: 30,
  maxUAMMinutes: 30,
  maxDeltaGlucoseThreshold: 0.2,
  highTempTargetRaisesSensitivity: false,
  lowTempTargetLowersSensitivity: false,
  sensitivityRaisesTarget: false,
  resistanceLowersTarget: false,
  halfBasalTarget: 160,
};

/** Trio's initial entries (`addInitialX`): target 110, basal 0.1, CR 30, ISF 200, all at 00:00. */
export const INITIAL_VALUES = { targets: 110, basal: 0.1, carbRatios: 30, isf: 200 } as const;

/** Trio locks DIA to its default of 10 hours during onboarding. */
export const ONBOARDING_DIA_HOURS = 10;

const toSchedule = (items: readonly TherapyItem[]) => validateItems(items).map((i) => ({ startMinute: Math.round(i.time / 60), value: i.value }));

export interface SettingsResult {
  readonly profile: TherapyProfile;
  readonly limits: SafetyLimits;
  readonly orefSettings: SettingsValues;
}

/**
 * `saveOnboardingData()` mapped onto Buddy: schedules → profile, delivery limits → SafetyLimits,
 * preferences → oref-smb algorithm settings. Keys the oref adapter does not read yet are stored
 * under Trio's preference names so nothing the user chose is lost.
 */
export function buildSettings(d: OnboardingDraft, current: { profile: TherapyProfile; limits: SafetyLimits; orefSettings: SettingsValues }): SettingsResult {
  const profile: TherapyProfile = {
    ...current.profile,
    basal: toSchedule(d.basal),
    carbRatio: toSchedule(d.carbRatios),
    isf: toSchedule(d.isf),
    target: toSchedule(d.targets).map((e) => ({ startMinute: e.startMinute, value: { low: e.value, high: e.value } })),
    diaHours: ONBOARDING_DIA_HOURS,
  };
  const limits: SafetyLimits = {
    ...current.limits,
    maxIOB: d.maxIOB,
    maxBolus: d.maxBolus,
    maxBasalRate: d.maxBasal,
    // The guard's hard floor is never lowered by onboarding; Trio's threshold goes to oref below.
    suspendThreshold: Math.max(current.limits.suspendThreshold, d.minimumSafetyThreshold),
  };
  const orefSettings: SettingsValues = {
    ...current.orefSettings,
    autosensMin: d.autosensMin,
    autosensMax: d.autosensMax,
    enableSMBAlways: d.enableSMBAlways,
    enableSMBWithCOB: d.enableSMBWithCOB,
    enableSMBAfterCarbs: d.enableSMBAfterCarbs,
    enableSMBHighBg: d.enableSMBWithHighGlucoseTarget,
    enableSMBHighBgTarget: d.highGlucoseTarget,
    enableUAM: d.enableUAM,
    maxSMBBasalMinutes: d.maxSMBMinutes,
    maxUAMSMBBasalMinutes: d.maxUAMMinutes,
    thresholdSetting: d.minimumSafetyThreshold,
    // Trio preferences without a Buddy oref setting yet (see report).
    rewindResetsAutosens: d.rewindResetsAutosens,
    enableSMBWithTempTarget: d.enableSMBWithTempTarget,
    allowSMBWithHighTempTarget: d.allowSMBWithHighTempTarget,
    maxDeltaBGThreshold: d.maxDeltaGlucoseThreshold,
    highTempTargetRaisesSensitivity: d.highTempTargetRaisesSensitivity,
    lowTempTargetLowersSensitivity: d.lowTempTargetLowersSensitivity,
    sensitivityRaisesTarget: d.sensitivityRaisesTarget,
    resistanceLowersTarget: d.resistanceLowersTarget,
    halfBasalExerciseTarget: d.halfBasalTarget,
    maxCOB: d.maxCOB,
  };
  return { profile, limits, orefSettings };
}

// MARK: Nightscout

/** `connectToNightscout` URL check: trailing slash removed, https required. */
export function normalizeNightscoutUrl(raw: string): string | null {
  const url = raw.trim().replace(/\/$/, '');
  if (!url.startsWith('https://')) return null;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

export interface ImportedTherapy {
  readonly units: GlucoseUnit;
  readonly targets: TherapyItem[];
  readonly basal: TherapyItem[];
  readonly carbRatios: TherapyItem[];
  readonly isf: TherapyItem[];
}

/** `importSettingsFromNightscout` + `finalizeImport`: validates like Trio and snaps onto the onboarding grids. */
export function importTherapy(body: unknown, pump: PumpModel): ImportedTherapy {
  const p = parseNightscoutProfile(body);
  if (p.carbRatio.some((e) => e.value <= 0)) throw new Error('Invalid Carb Ratio settings in Nightscout. Import aborted.');
  if (p.basal.some((e) => e.value <= 0)) throw new Error('Invalid Nightscout basal rates found. Import aborted.');
  if (p.basal.reduce((s, e) => s + e.value, 0) <= 0) throw new Error('Invalid Nightscout basal rates found. Basal rate total cannot be 0 U/hr. Import aborted.');
  if (p.isf.some((e) => e.value <= 0)) throw new Error('Invalid Nightscout insulin sensitivity profile. Import aborted.');
  const units: GlucoseUnit = profileUnits(body).includes('mmol') ? 'mmol/L' : 'mg/dL';
  const items = (s: readonly { startMinute: number; value: number }[], options: readonly number[]) => snapItems(s.map((e) => newItem(e.startMinute * 60, e.value)), options);
  return {
    units,
    targets: items(p.target.map((e) => ({ startMinute: e.startMinute, value: e.value.low })), pickerValues(PICKERS.target, units)),
    basal: items(p.basal, pickerValues(basalPicker(pump), units)),
    carbRatios: items(p.carbRatio, pickerValues(PICKERS.carbRatio, units)),
    isf: items(p.isf, pickerValues(PICKERS.isf, units)),
  };
}

function profileUnits(body: unknown): string {
  const doc = (Array.isArray(body) ? body[0] : body) as { store?: Record<string, { units?: unknown }>; defaultProfile?: unknown; units?: unknown } | undefined;
  const name = String(doc?.defaultProfile ?? Object.keys(doc?.store ?? {})[0] ?? '');
  return String(doc?.store?.[name]?.units ?? doc?.units ?? '').toLowerCase();
}
