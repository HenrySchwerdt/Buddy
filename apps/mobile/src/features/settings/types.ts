/** Copy of one Trio `SettingInputSection` (see trio-copy.ts for the token syntax). */
export interface TrioSettingCopy {
  readonly label: string;
  readonly miniHint: string;
  readonly hint: readonly string[];
  readonly header?: string;
  readonly conditionalLabel?: string;
}

/** Port of Trio's `PickerSetting.PickerSettingType`: decides how a value is displayed. */
export type PickerKind = 'glucose' | 'factor' | 'gram' | 'insulinUnit' | 'insulinUnitPerHour' | 'minute' | 'hour';

/** Port of Trio's `PickerSetting` (DecimalPickerSettings.swift). Glucose values are mg/dL. */
export interface PickerSetting {
  readonly step: number;
  readonly min: number;
  readonly max: number;
  readonly kind: PickerKind;
}
