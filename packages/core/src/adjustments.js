import { minuteOfDay, scheduleValueAt } from './schedule';
import { MINUTE } from './units';
export const MIN_OVERRIDE_PERCENT = 10;
export const MAX_OVERRIDE_PERCENT = 200;
/** Override target range (Trio `AddOverrideForm`: 72–270 mg/dL). */
export const MIN_TEMP_TARGET = 72;
export const MAX_TEMP_TARGET = 270;
/** Temp target picker range (Trio `AddTempTargetForm`: 80–200 mg/dL, 80 is oref's lowest TT). */
export const MIN_TT_TARGET = 80;
export const MAX_TT_TARGET = 200;
/** Picker ranges from Trio's forms. */
export const OVERRIDE_PICKER_PERCENT = { min: 40, max: 150 };
export const MAX_SMB_MINUTES_PICKER = 180;
export const MAX_DURATION_PICKER_MIN = 23 * 60 + 55;
export const isOverrideActive = (o, now) => !!o && o.startedAt <= now && (o.durationMin === null || now < o.startedAt + o.durationMin * MINUTE);
export const isTempTargetActive = (t, now) => !!t && t.startedAt <= now && now < t.startedAt + t.durationMin * MINUTE;
export const isTempTargetScheduled = (t, now) => !!t && t.startedAt > now;
// ---------------------------------------------------------------------------------------------
// Inverse change / SMB mode helpers
// ---------------------------------------------------------------------------------------------
export function inverseChangeOf(o) {
    if (o.scaleIsf && o.scaleCr)
        return 'isfAndCr';
    if (o.scaleIsf)
        return 'isf';
    if (o.scaleCr)
        return 'cr';
    return 'none';
}
export function inverseChangeFlags(mode) {
    return { scaleIsf: mode === 'isfAndCr' || mode === 'isf', scaleCr: mode === 'isfAndCr' || mode === 'cr' };
}
export function disableSmbModeOf(o) {
    if (o.smbIsScheduledOff)
        return 'disableOnSchedule';
    return o.disableSmb ? 'disable' : 'dontDisable';
}
export function disableSmbFlags(mode) {
    return { disableSmb: mode === 'disable', smbIsScheduledOff: mode === 'disableOnSchedule' };
}
/**
 * Whether `hour` (0–23) falls in a scheduled SMB-off window, exactly like oref's `enable_smb`:
 * [start, end) wrapping past midnight; 0 → 0 is all day; equal hours mean that one hour.
 */
export function isInSmbOffWindow(startHour, endHour, hour) {
    if (startHour < endHour)
        return hour >= startHour && hour < endHour;
    if (startHour > endHour)
        return hour >= startHour || hour < endHour;
    if (startHour === 0 && endHour === 0)
        return true;
    return hour === startHour;
}
// ---------------------------------------------------------------------------------------------
// Validation (Trio's form rules and copy)
// ---------------------------------------------------------------------------------------------
export function validateOverride(o) {
    const errors = [];
    if (!(o.percentage >= MIN_OVERRIDE_PERCENT && o.percentage <= MAX_OVERRIDE_PERCENT))
        errors.push(`Percentage must be ${MIN_OVERRIDE_PERCENT}–${MAX_OVERRIDE_PERCENT} %`);
    if (o.target !== null && !(o.target >= MIN_TEMP_TARGET && o.target <= MAX_TEMP_TARGET))
        errors.push(`Target must be ${MIN_TEMP_TARGET}–${MAX_TEMP_TARGET} mg/dL`);
    if (o.durationMin !== null && !(o.durationMin > 0 && o.durationMin <= 7 * 24 * 60))
        errors.push('Duration must be up to 7 days');
    if (o.smbIsScheduledOff && !(isHour(o.smbOffStartHour ?? 0) && isHour(o.smbOffEndHour ?? 0)))
        errors.push('SMB schedule hours must be 0–23');
    if (o.overrideSmbMinutes && !(isMinutes(o.smbMinutes) && isMinutes(o.uamMinutes)))
        errors.push(`SMB/UAM minutes must be 0–${MAX_SMB_MINUTES_PICKER}`);
    return errors;
}
const isHour = (h) => Number.isInteger(h) && h >= 0 && h <= 23;
const isMinutes = (m) => m !== undefined && m >= 0 && m <= MAX_SMB_MINUTES_PICKER;
export function validateTempTarget(t) {
    const errors = [];
    if (!(t.target >= MIN_TT_TARGET && t.target <= MAX_TEMP_TARGET))
        errors.push(`Target must be ${MIN_TT_TARGET}–${MAX_TEMP_TARGET} mg/dL`);
    if (!(t.durationMin > 0 && t.durationMin <= 24 * 60))
        errors.push('Duration must be up to 24 h');
    return errors;
}
/** Trio `isOverrideInvalid()`: the first problem, as the orange message above "Start Override". */
export function overrideDraftError(d, units) {
    if (!d.indefinite && d.durationMin === 0)
        return 'Enable indefinitely or set a duration.';
    if (d.overrideTarget && (d.target < MIN_TEMP_TARGET || d.target > MAX_TEMP_TARGET))
        return `Target glucose is out of range (${units === 'mg/dL' ? '72-270' : '4-14'}).`;
    if (d.percentage === 100 && !d.overrideTarget && !d.overrideSmbMinutes && !d.disableSmb && !d.smbIsScheduledOff)
        return 'All settings are at default values.';
    return null;
}
/** Trio `isTempTargetInvalid()`. */
export function tempTargetDraftError(d, units) {
    if (d.durationMin === 0)
        return 'Set a duration!';
    if (d.target < MIN_TT_TARGET)
        return `${units === 'mg/dL' ? '80 ' : '4.4 '}${units} needed as min. Glucose Target)!`;
    return null;
}
/** Trio `isSavePresetInvalid()`: presets can't carry a future start. */
export function tempTargetPresetError(d, now, units) {
    return tempTargetDraftError(d, units) ?? (d.startAt > now ? 'Presets cannot be saved with a future date!' : null);
}
/** Trio `percentageDescription`: footer under the percentage. */
export function percentageDescription(percent) {
    if (!Number.isFinite(percent) || percent === 100)
        return null;
    const change = Math.round(Math.abs(percent - 100));
    return percent < 100 ? `Insulin doses will be decreased by ${change} %.` : `Insulin doses will be increased by ${change} %.`;
}
/** Trio `roundOverridePercentageToStep`: snap towards 100 to the step grid, clamp 10–200. */
export function roundOverridePercentageToStep(percentage, step) {
    if (percentage % step === 0)
        return percentage;
    const rounded = percentage > 100 ? 100 + Math.floor((percentage - 100) / step) * step : 100 - Math.floor((100 - percentage) / step) * step;
    return Math.max(MIN_OVERRIDE_PERCENT, Math.min(rounded, MAX_OVERRIDE_PERCENT));
}
/** Trio `roundTargetToStep`: round up to the next multiple of `step`. */
export function roundTargetToStep(target, step) {
    const remainder = target % step;
    return remainder === 0 ? target : target + (step - remainder);
}
/** Trio `generatePickerValues(roundMinToStep: true)`: min moved up onto the step grid. */
export function targetPickerValues(min, max, step) {
    const start = roundTargetToStep(min, step);
    const values = [];
    for (let v = start; v <= max; v += step)
        values.push(v);
    return values;
}
// ---------------------------------------------------------------------------------------------
// Temp target sensitivity (Trio TempTargetCalculations)
// ---------------------------------------------------------------------------------------------
export const TT_NORMAL_TARGET = 100;
export const TT_MIN_SENSITIVITY_PERCENT = 15;
function rawTtPercentage(halfBasalTarget, target, autosensMax) {
    const deviation = halfBasalTarget - TT_NORMAL_TARGET;
    const factor = deviation + (target - TT_NORMAL_TARGET);
    const ratio = deviation * factor <= 0 ? autosensMax : deviation / factor;
    return Math.min(ratio, autosensMax) * 100;
}
/** Insulin percentage a temp target yields with oref's half-basal formula (min 15 %). */
export function computeAdjustedPercentage(halfBasalTarget, target, autosensMax) {
    return Math.max(rawTtPercentage(halfBasalTarget, target, autosensMax), TT_MIN_SENSITIVITY_PERCENT);
}
/** Half-basal target that yields `percentage` at `target`. */
export function computeHalfBasalTarget(target, percentage) {
    const ratio = Math.max(percentage, TT_MIN_SENSITIVITY_PERCENT) / 100;
    if (ratio === 1)
        return 160;
    return Math.round((2 * ratio * TT_NORMAL_TARGET - TT_NORMAL_TARGET - ratio * target) / (ratio - 1));
}
/** HBT oref should use for a temp target; null = the setting as is. */
export function computeEffectiveHBT(tempTargetHalfBasalTarget, settingHalfBasalTarget, target, autosensMax) {
    if (tempTargetHalfBasalTarget != null)
        return tempTargetHalfBasalTarget;
    if (rawTtPercentage(settingHalfBasalTarget, target, autosensMax) <= TT_MIN_SENSITIVITY_PERCENT)
        return computeHalfBasalTarget(target, TT_MIN_SENSITIVITY_PERCENT);
    return null;
}
export const DEFAULT_TARGET_BEHAVIOR = {
    halfBasalExerciseTarget: 160,
    highTemptargetRaisesSensitivity: false,
    lowTemptargetLowersSensitivity: false,
    exerciseMode: false,
    autosensMax: 1.2,
};
/** Trio `isAdjustSensEnabled`. */
export function isAdjustSensEnabled(target, b) {
    if (target < TT_NORMAL_TARGET && b.lowTemptargetLowersSensitivity && b.autosensMax > 1)
        return true;
    if (target > TT_NORMAL_TARGET && (b.highTemptargetRaisesSensitivity || b.exerciseMode))
        return true;
    return false;
}
/** Trio `computeSliderLow` / `computeSliderHigh` (percent). */
export function ttSliderRange(target, autosensMax) {
    if (target === 0)
        return { low: TT_MIN_SENSITIVITY_PERCENT, high: autosensMax * 100 };
    return {
        low: target < TT_NORMAL_TARGET ? 105 : TT_MIN_SENSITIVITY_PERCENT,
        high: target > TT_NORMAL_TARGET ? 95 : autosensMax * 100,
    };
}
/**
 * Values an algorithm or the bolus calculator should dose with at `now`.
 * Precedence for the target: temp target > override target > profile.
 */
export function effectiveSettings(profile, now, override, tempTarget) {
    const at = (s) => scheduleValueAt(s, now, profile.utcOffsetMinutes);
    const active = isOverrideActive(override ?? null, now) ? override : null;
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
export const DEFAULT_OVERRIDE_PRESETS = [];
export const DEFAULT_TEMP_TARGET_PRESETS = [];
