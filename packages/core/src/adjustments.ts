import { minuteOfDay, scheduleValueAt } from './schedule';
import type { Millis, TargetRange, TherapyProfile } from './types';
import { MINUTE } from './units';

/**
 * Trio-style adjustments: profile overrides (insulin needs in %, optional target, SMB off)
 * and temporary targets. They never rewrite the therapy profile — IOB keeps being computed
 * against the pump's real basal schedule — algorithms read the effective values instead.
 *
 * Field semantics follow Trio's `OverrideStored` / `TempTargetStored`
 * (Trio/Sources/Modules/Adjustments, OpenAPS.prepareTrioCustomOrefVariables).
 */

/** Trio's "Also Inversely Change" picker (`IsfAndOrCrOptions`). */
export type InverseChange = 'isfAndCr' | 'isf' | 'cr' | 'none';

/** Trio's "Disable SMBs" picker (`DisableSmbOptions`). */
export type DisableSmbMode = 'dontDisable' | 'disable' | 'disableOnSchedule';

export interface OverridePreset {
  readonly id: string;
  readonly name: string;
  /** Insulin needs in percent (100 = unchanged). Scales basal, and ISF/CR when enabled. */
  readonly percentage: number;
  /** Override target in mg/dL (null = keep profile target). */
  readonly target: number | null;
  readonly scaleIsf: boolean;
  readonly scaleCr: boolean;
  /** SMBs off for the whole override (Trio `smbIsOff`). */
  readonly disableSmb: boolean;
  /** null = until cancelled (Trio `indefinite`). */
  readonly durationMin: number | null;
  /** SMBs off only from `smbOffStartHour` up to `smbOffEndHour` (Trio `smbIsScheduledOff`, `start`, `end`). */
  readonly smbIsScheduledOff?: boolean;
  /** Hour of day 0–23. */
  readonly smbOffStartHour?: number;
  /** Hour of day 0–23 (exclusive). 0 → 0 means all day, equal hours mean that one hour. */
  readonly smbOffEndHour?: number;
  /** "Override Max SMB Minutes" (Trio `advancedSettings`). */
  readonly overrideSmbMinutes?: boolean;
  /** Max SMB basal minutes while `overrideSmbMinutes` (Trio `smbMinutes`). */
  readonly smbMinutes?: number;
  /** Max UAM SMB basal minutes while `overrideSmbMinutes` (Trio `uamMinutes`). */
  readonly uamMinutes?: number;
}

export interface ActiveOverride extends OverridePreset {
  readonly startedAt: Millis;
  /** Id of the preset this run was started from (Trio `isPreset`); editing that preset also edits the run. */
  readonly presetId?: string;
}

export interface TempTargetPreset {
  readonly id: string;
  readonly name: string;
  /** mg/dL */
  readonly target: number;
  readonly durationMin: number;
  /** Custom half-basal exercise target (Trio "Sensitivity Adjustment: Custom"); null/undefined = setting. */
  readonly halfBasalTarget?: number | null;
}

export interface ActiveTempTarget extends TempTargetPreset {
  /** May be in the future: a scheduled temp target. */
  readonly startedAt: Millis;
  readonly presetId?: string;
}

export const MIN_OVERRIDE_PERCENT = 10;
export const MAX_OVERRIDE_PERCENT = 200;
/** Override target range (Trio `AddOverrideForm`: 72–270 mg/dL). */
export const MIN_TEMP_TARGET = 72;
export const MAX_TEMP_TARGET = 270;
/** Temp target picker range (Trio `AddTempTargetForm`: 80–200 mg/dL, 80 is oref's lowest TT). */
export const MIN_TT_TARGET = 80;
export const MAX_TT_TARGET = 200;
/** Picker ranges from Trio's forms. */
export const OVERRIDE_PICKER_PERCENT = { min: 40, max: 150 } as const;
export const MAX_SMB_MINUTES_PICKER = 180;
export const MAX_DURATION_PICKER_MIN = 23 * 60 + 55;

export const isOverrideActive = (o: ActiveOverride | null | undefined, now: Millis): o is ActiveOverride =>
  !!o && o.startedAt <= now && (o.durationMin === null || now < o.startedAt + o.durationMin * MINUTE);

export const isTempTargetActive = (t: ActiveTempTarget | null | undefined, now: Millis): t is ActiveTempTarget =>
  !!t && t.startedAt <= now && now < t.startedAt + t.durationMin * MINUTE;

export const isTempTargetScheduled = (t: ActiveTempTarget | null | undefined, now: Millis): t is ActiveTempTarget => !!t && t.startedAt > now;

// ---------------------------------------------------------------------------------------------
// Inverse change / SMB mode helpers
// ---------------------------------------------------------------------------------------------

export function inverseChangeOf(o: Pick<OverridePreset, 'scaleIsf' | 'scaleCr'>): InverseChange {
  if (o.scaleIsf && o.scaleCr) return 'isfAndCr';
  if (o.scaleIsf) return 'isf';
  if (o.scaleCr) return 'cr';
  return 'none';
}

export function inverseChangeFlags(mode: InverseChange): { scaleIsf: boolean; scaleCr: boolean } {
  return { scaleIsf: mode === 'isfAndCr' || mode === 'isf', scaleCr: mode === 'isfAndCr' || mode === 'cr' };
}

export function disableSmbModeOf(o: Pick<OverridePreset, 'disableSmb' | 'smbIsScheduledOff'>): DisableSmbMode {
  if (o.smbIsScheduledOff) return 'disableOnSchedule';
  return o.disableSmb ? 'disable' : 'dontDisable';
}

export function disableSmbFlags(mode: DisableSmbMode): { disableSmb: boolean; smbIsScheduledOff: boolean } {
  return { disableSmb: mode === 'disable', smbIsScheduledOff: mode === 'disableOnSchedule' };
}

/**
 * Whether `hour` (0–23) falls in a scheduled SMB-off window, exactly like oref's `enable_smb`:
 * [start, end) wrapping past midnight; 0 → 0 is all day; equal hours mean that one hour.
 */
export function isInSmbOffWindow(startHour: number, endHour: number, hour: number): boolean {
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  if (startHour > endHour) return hour >= startHour || hour < endHour;
  if (startHour === 0 && endHour === 0) return true;
  return hour === startHour;
}

// ---------------------------------------------------------------------------------------------
// Validation (Trio's form rules and copy)
// ---------------------------------------------------------------------------------------------

export function validateOverride(o: OverridePreset): string[] {
  const errors: string[] = [];
  if (!(o.percentage >= MIN_OVERRIDE_PERCENT && o.percentage <= MAX_OVERRIDE_PERCENT)) errors.push(`Percentage must be ${MIN_OVERRIDE_PERCENT}–${MAX_OVERRIDE_PERCENT} %`);
  if (o.target !== null && !(o.target >= MIN_TEMP_TARGET && o.target <= MAX_TEMP_TARGET)) errors.push(`Target must be ${MIN_TEMP_TARGET}–${MAX_TEMP_TARGET} mg/dL`);
  if (o.durationMin !== null && !(o.durationMin > 0 && o.durationMin <= 7 * 24 * 60)) errors.push('Duration must be up to 7 days');
  if (o.smbIsScheduledOff && !(isHour(o.smbOffStartHour ?? 0) && isHour(o.smbOffEndHour ?? 0))) errors.push('SMB schedule hours must be 0–23');
  if (o.overrideSmbMinutes && !(isMinutes(o.smbMinutes) && isMinutes(o.uamMinutes))) errors.push(`SMB/UAM minutes must be 0–${MAX_SMB_MINUTES_PICKER}`);
  return errors;
}

const isHour = (h: number) => Number.isInteger(h) && h >= 0 && h <= 23;
const isMinutes = (m: number | undefined) => m !== undefined && m >= 0 && m <= MAX_SMB_MINUTES_PICKER;

export function validateTempTarget(t: TempTargetPreset): string[] {
  const errors: string[] = [];
  if (!(t.target >= MIN_TT_TARGET && t.target <= MAX_TEMP_TARGET)) errors.push(`Target must be ${MIN_TT_TARGET}–${MAX_TEMP_TARGET} mg/dL`);
  if (!(t.durationMin > 0 && t.durationMin <= 24 * 60)) errors.push('Duration must be up to 24 h');
  return errors;
}

/** Form state of Trio's Add/Edit Override sheet, as far as validation needs it. */
export interface OverrideDraftCheck {
  readonly percentage: number;
  readonly indefinite: boolean;
  readonly durationMin: number;
  readonly overrideTarget: boolean;
  readonly target: number;
  readonly overrideSmbMinutes: boolean;
  readonly disableSmb: boolean;
  readonly smbIsScheduledOff: boolean;
}

/** Trio `isOverrideInvalid()`: the first problem, as the orange message above "Start Override". */
export function overrideDraftError(d: OverrideDraftCheck, units: 'mg/dL' | 'mmol/L'): string | null {
  if (!d.indefinite && d.durationMin === 0) return 'Enable indefinitely or set a duration.';
  if (d.overrideTarget && (d.target < MIN_TEMP_TARGET || d.target > MAX_TEMP_TARGET)) return `Target glucose is out of range (${units === 'mg/dL' ? '72-270' : '4-14'}).`;
  if (d.percentage === 100 && !d.overrideTarget && !d.overrideSmbMinutes && !d.disableSmb && !d.smbIsScheduledOff) return 'All settings are at default values.';
  return null;
}

/** Trio `isTempTargetInvalid()`. */
export function tempTargetDraftError(d: { readonly target: number; readonly durationMin: number }, units: 'mg/dL' | 'mmol/L'): string | null {
  if (d.durationMin === 0) return 'Set a duration!';
  if (d.target < MIN_TT_TARGET) return `${units === 'mg/dL' ? '80 ' : '4.4 '}${units} needed as min. Glucose Target)!`;
  return null;
}

/** Trio `isSavePresetInvalid()`: presets can't carry a future start. */
export function tempTargetPresetError(d: { readonly target: number; readonly durationMin: number; readonly startAt: Millis }, now: Millis, units: 'mg/dL' | 'mmol/L'): string | null {
  return tempTargetDraftError(d, units) ?? (d.startAt > now ? 'Presets cannot be saved with a future date!' : null);
}

/** Trio `percentageDescription`: footer under the percentage. */
export function percentageDescription(percent: number): string | null {
  if (!Number.isFinite(percent) || percent === 100) return null;
  const change = Math.round(Math.abs(percent - 100));
  return percent < 100 ? `Insulin doses will be decreased by ${change} %.` : `Insulin doses will be increased by ${change} %.`;
}

/** Trio `roundOverridePercentageToStep`: snap towards 100 to the step grid, clamp 10–200. */
export function roundOverridePercentageToStep(percentage: number, step: number): number {
  if (percentage % step === 0) return percentage;
  const rounded = percentage > 100 ? 100 + Math.floor((percentage - 100) / step) * step : 100 - Math.floor((100 - percentage) / step) * step;
  return Math.max(MIN_OVERRIDE_PERCENT, Math.min(rounded, MAX_OVERRIDE_PERCENT));
}

/** Trio `roundTargetToStep`: round up to the next multiple of `step`. */
export function roundTargetToStep(target: number, step: number): number {
  const remainder = target % step;
  return remainder === 0 ? target : target + (step - remainder);
}

/** Trio `generatePickerValues(roundMinToStep: true)`: min moved up onto the step grid. */
export function targetPickerValues(min: number, max: number, step: number): number[] {
  const start = roundTargetToStep(min, step);
  const values: number[] = [];
  for (let v = start; v <= max; v += step) values.push(v);
  return values;
}

// ---------------------------------------------------------------------------------------------
// Temp target sensitivity (Trio TempTargetCalculations)
// ---------------------------------------------------------------------------------------------

export const TT_NORMAL_TARGET = 100;
export const TT_MIN_SENSITIVITY_PERCENT = 15;

function rawTtPercentage(halfBasalTarget: number, target: number, autosensMax: number): number {
  const deviation = halfBasalTarget - TT_NORMAL_TARGET;
  const factor = deviation + (target - TT_NORMAL_TARGET);
  const ratio = deviation * factor <= 0 ? autosensMax : deviation / factor;
  return Math.min(ratio, autosensMax) * 100;
}

/** Insulin percentage a temp target yields with oref's half-basal formula (min 15 %). */
export function computeAdjustedPercentage(halfBasalTarget: number, target: number, autosensMax: number): number {
  return Math.max(rawTtPercentage(halfBasalTarget, target, autosensMax), TT_MIN_SENSITIVITY_PERCENT);
}

/** Half-basal target that yields `percentage` at `target`. */
export function computeHalfBasalTarget(target: number, percentage: number): number {
  const ratio = Math.max(percentage, TT_MIN_SENSITIVITY_PERCENT) / 100;
  if (ratio === 1) return 160;
  return Math.round((2 * ratio * TT_NORMAL_TARGET - TT_NORMAL_TARGET - ratio * target) / (ratio - 1));
}

/** HBT oref should use for a temp target; null = the setting as is. */
export function computeEffectiveHBT(tempTargetHalfBasalTarget: number | null | undefined, settingHalfBasalTarget: number, target: number, autosensMax: number): number | null {
  if (tempTargetHalfBasalTarget != null) return tempTargetHalfBasalTarget;
  if (rawTtPercentage(settingHalfBasalTarget, target, autosensMax) <= TT_MIN_SENSITIVITY_PERCENT) return computeHalfBasalTarget(target, TT_MIN_SENSITIVITY_PERCENT);
  return null;
}

/** Trio Target Behavior preferences relevant to temp targets. */
export interface TargetBehavior {
  readonly halfBasalExerciseTarget: number;
  readonly highTemptargetRaisesSensitivity: boolean;
  readonly lowTemptargetLowersSensitivity: boolean;
  readonly exerciseMode: boolean;
  readonly autosensMax: number;
}

export const DEFAULT_TARGET_BEHAVIOR: TargetBehavior = {
  halfBasalExerciseTarget: 160,
  highTemptargetRaisesSensitivity: false,
  lowTemptargetLowersSensitivity: false,
  exerciseMode: false,
  autosensMax: 1.2,
};

/** Trio `isAdjustSensEnabled`. */
export function isAdjustSensEnabled(target: number, b: TargetBehavior): boolean {
  if (target < TT_NORMAL_TARGET && b.lowTemptargetLowersSensitivity && b.autosensMax > 1) return true;
  if (target > TT_NORMAL_TARGET && (b.highTemptargetRaisesSensitivity || b.exerciseMode)) return true;
  return false;
}

/** Trio `computeSliderLow` / `computeSliderHigh` (percent). */
export function ttSliderRange(target: number, autosensMax: number): { low: number; high: number } {
  if (target === 0) return { low: TT_MIN_SENSITIVITY_PERCENT, high: autosensMax * 100 };
  return {
    low: target < TT_NORMAL_TARGET ? 105 : TT_MIN_SENSITIVITY_PERCENT,
    high: target > TT_NORMAL_TARGET ? 95 : autosensMax * 100,
  };
}

// ---------------------------------------------------------------------------------------------
// Effective settings for the non-oref algorithms and the bolus calculator
// ---------------------------------------------------------------------------------------------

export interface EffectiveSettings {
  readonly basal: number;
  readonly isf: number;
  readonly carbRatio: number;
  readonly target: TargetRange;
  /** SMBs off right now (whole override, or inside its scheduled window). */
  readonly smbDisabled: boolean;
  readonly overrideFactor: number;
  /** Override's max SMB / UAM basal minutes, null = algorithm setting. */
  readonly maxSmbMinutes: number | null;
  readonly maxUamMinutes: number | null;
}

/**
 * Values an algorithm or the bolus calculator should dose with at `now`.
 * Precedence for the target: temp target > override target > profile.
 */
export function effectiveSettings(
  profile: TherapyProfile,
  now: Millis,
  override?: ActiveOverride | null,
  tempTarget?: { readonly low: number; readonly high: number } | null,
): EffectiveSettings {
  const at = <T>(s: readonly { startMinute: number; value: T }[]) => scheduleValueAt(s, now, profile.utcOffsetMinutes);
  const active = isOverrideActive(override ?? null, now) ? override! : null;
  const f = active ? active.percentage / 100 : 1;
  const profileTarget = at(profile.target);
  const target = tempTarget ?? (active && active.target !== null && active.target !== 0 ? { low: active.target, high: active.target } : profileTarget);
  const hour = Math.floor(minuteOfDay(now, profile.utcOffsetMinutes) / 60);
  const scheduledOff = !!active?.smbIsScheduledOff && isInSmbOffWindow(active.smbOffStartHour ?? 0, active.smbOffEndHour ?? 0, hour);
  const minutes = active?.overrideSmbMinutes && !active.disableSmb;
  return {
    basal: at(profile.basal) * f,
    isf: active?.scaleIsf ? at(profile.isf) / f : at(profile.isf),
    carbRatio: active?.scaleCr ? at(profile.carbRatio) / f : at(profile.carbRatio),
    target,
    smbDisabled: (active?.disableSmb ?? false) || scheduledOff,
    overrideFactor: f,
    maxSmbMinutes: minutes ? (active.smbMinutes ?? null) : null,
    maxUamMinutes: minutes ? (active.uamMinutes ?? null) : null,
  };
}

/** Trio ships without presets; the lists start empty ("Add Preset or Override by tapping …"). */
export const DEFAULT_OVERRIDE_PRESETS: readonly OverridePreset[] = [];
export const DEFAULT_TEMP_TARGET_PRESETS: readonly TempTargetPreset[] = [];
