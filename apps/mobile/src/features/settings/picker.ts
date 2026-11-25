import { toMmol, type GlucoseUnit } from '@buddy/core';
import type { PickerKind, PickerSetting } from './types';

/** Trio's DecimalPickerSettings (Models/DecimalPickerSettings.swift), keyed like Trio. */
export const PICKERS = {
  carbsRequiredThreshold: { step: 1, min: 0, max: 100, kind: 'gram' },
  individualAdjustmentFactor: { step: 0.05, min: 0.1, max: 1.2, kind: 'factor' },
  high: { step: 1, min: 100, max: 400, kind: 'glucose' },
  low: { step: 1, min: 40, max: 100, kind: 'glucose' },
  maxCarbs: { step: 5, min: 0, max: 300, kind: 'gram' },
  maxFat: { step: 5, min: 0, max: 300, kind: 'gram' },
  maxProtein: { step: 5, min: 0, max: 300, kind: 'gram' },
  overrideFactor: { step: 0.05, min: 0.05, max: 1.5, kind: 'factor' },
  fattyMealFactor: { step: 0.05, min: 0.05, max: 1, kind: 'factor' },
  sweetMealFactor: { step: 0.05, min: 0.05, max: 2, kind: 'factor' },
  maxIOB: { step: 1, min: 0, max: 30, kind: 'insulinUnit' },
  maxDailySafetyMultiplier: { step: 0.1, min: 1, max: 5, kind: 'factor' },
  currentBasalSafetyMultiplier: { step: 0.1, min: 1, max: 5, kind: 'factor' },
  autosensMax: { step: 0.05, min: 0.5, max: 2, kind: 'factor' },
  autosensMin: { step: 0.05, min: 0.5, max: 1, kind: 'factor' },
  smbDeliveryRatio: { step: 0.05, min: 0.3, max: 0.7, kind: 'factor' },
  halfBasalExerciseTarget: { step: 5, min: 105, max: 300, kind: 'glucose' },
  maxCOB: { step: 5, min: 0, max: 300, kind: 'gram' },
  maxMealAbsorptionTime: { step: 1, min: 4, max: 10, kind: 'hour' },
  min5mCarbimpact: { step: 1, min: 1, max: 20, kind: 'glucose' },
  remainingCarbsFraction: { step: 0.05, min: 0.5, max: 1, kind: 'factor' },
  remainingCarbsCap: { step: 5, min: 0, max: 200, kind: 'gram' },
  maxSMBBasalMinutes: { step: 5, min: 15, max: 180, kind: 'minute' },
  maxUAMSMBBasalMinutes: { step: 5, min: 15, max: 180, kind: 'minute' },
  smbInterval: { step: 1, min: 1, max: 10, kind: 'minute' },
  insulinPeakTime: { step: 1, min: 35, max: 120, kind: 'minute' },
  noisyCGMTargetMultiplier: { step: 0.05, min: 1, max: 2, kind: 'factor' },
  maxDeltaBGthreshold: { step: 0.05, min: 0.1, max: 0.4, kind: 'factor' },
  adjustmentFactor: { step: 0.05, min: 0.3, max: 3, kind: 'factor' },
  adjustmentFactorSigmoid: { step: 0.05, min: 0.1, max: 2, kind: 'factor' },
  weightPercentage: { step: 0.05, min: 0.05, max: 1, kind: 'factor' },
  enableSMB_high_bg_target: { step: 1, min: 70, max: 200, kind: 'glucose' },
  threshold_setting: { step: 1, min: 60, max: 120, kind: 'glucose' },
  delay: { step: 5, min: 15, max: 120, kind: 'minute' },
  minuteInterval: { step: 5, min: 30, max: 60, kind: 'minute' },
  dia: { step: 0.5, min: 5, max: 10, kind: 'hour' },
  maxBolus: { step: 0.5, min: 0.5, max: 30, kind: 'insulinUnit' },
  maxBasal: { step: 0.5, min: 0.5, max: 30, kind: 'insulinUnitPerHour' },
} as const satisfies Record<string, PickerSetting>;

export type PickerKey = keyof typeof PICKERS;

const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Port of `PickerSettingsProvider.generatePickerValues`, de-duplicating mmol/L glucose values. */
export function pickerValues(setting: PickerSetting, units: GlucoseUnit): number[] {
  const values: number[] = [];
  const count = Math.round((setting.max - setting.min) / setting.step);
  for (let i = 0; i <= count; i++) values.push(round(setting.min + i * setting.step));
  if (units !== 'mmol/L' || setting.kind !== 'glucose') return values;
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = toMmol(v).toFixed(1);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Glucose (mg/dL) in the user's unit, without unit: "110" / "6.1". */
export const fmtGlucoseValue = (mgdl: number, units: GlucoseUnit) => (units === 'mmol/L' ? toMmol(mgdl).toFixed(1) : String(Math.round(mgdl)));

/** Trio `Decimal.formatted` without trailing zeros: 0.5 → "0.5", 2 → "2". */
export const fmtDecimal = (v: number) => String(round(v, 3));

/** Port of SettingInputSection.displayString(for:decimalValue:). */
export function fmtPickerValue(kind: PickerKind, value: number, units: GlucoseUnit): string {
  switch (kind) {
    case 'glucose':
      return `${fmtGlucoseValue(value, units)} ${units}`;
    case 'factor':
      return `${Math.round(value * 100)}%`;
    case 'insulinUnit':
      return `${fmtDecimal(value)} U`;
    case 'insulinUnitPerHour':
      return `${fmtDecimal(value)} U/hr`;
    case 'gram':
      return `${fmtDecimal(value)} g`;
    case 'minute':
      return `${fmtDecimal(value)} min`;
    case 'hour':
      return `${fmtDecimal(value)} hr`;
  }
}

/** Index of the picker value closest to `value` (Trio's `findClosestIndex`). */
export function closestIndex(values: readonly number[], value: number): number {
  let best = 0;
  values.forEach((v, i) => {
    if (Math.abs(v - value) < Math.abs(values[best]! - value)) best = i;
  });
  return best;
}

/** Restricts a Trio picker to the bounds a plugin schema enforces (normalizeSettings clamps to them). */
export function intersectPicker(setting: PickerSetting, bounds?: { min: number; max: number }): PickerSetting {
  if (!bounds) return setting;
  return { ...setting, min: Math.max(setting.min, bounds.min), max: Math.min(setting.max, bounds.max) };
}
