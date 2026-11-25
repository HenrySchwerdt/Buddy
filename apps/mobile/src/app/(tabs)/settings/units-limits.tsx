import type { GlucoseUnit, SafetyLimits } from '@buddy/core';
import { PickerRow, Section } from '@/trio';
import { useSettings } from '@/runtime/settings-store';
import { useOrefDecimal, useTreatmentDecimal } from '@/features/settings/bindings';
import { SettingInputSection, type DecimalBinding } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { BUDDY_LIMIT_COPY } from '@/features/settings/buddy-copy';
import { PICKERS } from '@/features/settings/picker';
import { TRIO_COPY } from '@/features/settings/trio-copy';
import type { PickerSetting } from '@/features/settings/types';

const UNIT_OPTIONS: readonly { value: GlucoseUnit; label: string }[] = [
  { value: 'mg/dL', label: 'mg/dL' },
  { value: 'mmol/L', label: 'mmol/L' },
];

/** Buddy SafetyGuard limits Trio has no picker for (bounds from Buddy's former safety screen). */
const GUARD_PICKERS = {
  maxAutoBolus: { step: 0.05, min: 0, max: 5, kind: 'insulinUnit' },
  suspendThreshold: { step: 1, min: 60, max: 120, kind: 'glucose' },
  maxGlucoseAgeMinutes: { step: 1, min: 6, max: 20, kind: 'minute' },
  minAutoBolusIntervalMinutes: { step: 1, min: 3, max: 30, kind: 'minute' },
} as const satisfies Partial<Record<keyof SafetyLimits, PickerSetting>>;

function useLimit(key: keyof SafetyLimits, picker: PickerSetting): DecimalBinding {
  const limits = useSettings((s) => s.limits);
  const update = useSettings((s) => s.update);
  return { value: limits[key], onChange: (v) => update({ limits: { ...useSettings.getState().limits, [key]: v } }), picker };
}

/** Port of UnitsLimitsSettings.RootView plus Buddy's SafetyGuard limits. */
export default function UnitsLimits() {
  const units = useSettings((s) => s.units);
  const update = useSettings((s) => s.update);
  return (
    <SettingsScreen title="Units and Limits">
      <Section header="Buddy Core Setup">
        <PickerRow label="Glucose Units" value={units} options={UNIT_OPTIONS} onChange={(u) => update({ units: u })} />
      </Section>
      <SettingInputSection copy={TRIO_COPY.maxIOB} decimal={useLimit('maxIOB', PICKERS.maxIOB)} />
      <SettingInputSection copy={TRIO_COPY.maxBolus} decimal={useLimit('maxBolus', PICKERS.maxBolus)} />
      <SettingInputSection copy={TRIO_COPY.maxBasal} decimal={useLimit('maxBasalRate', PICKERS.maxBasal)} />
      <SettingInputSection copy={TRIO_COPY.maxCOB} decimal={useTreatmentDecimal('maxCOB', 'maxCOB')} />
      <SettingInputSection copy={TRIO_COPY.threshold_setting} decimal={useOrefDecimal('thresholdSetting', 'threshold_setting')} />

      <SettingInputSection copy={BUDDY_LIMIT_COPY.maxAutoBolus} decimal={useLimit('maxAutoBolus', GUARD_PICKERS.maxAutoBolus)} />
      <SettingInputSection copy={BUDDY_LIMIT_COPY.suspendThreshold} decimal={useLimit('suspendThreshold', GUARD_PICKERS.suspendThreshold)} />
      <SettingInputSection copy={BUDDY_LIMIT_COPY.maxGlucoseAgeMinutes} decimal={useLimit('maxGlucoseAgeMinutes', GUARD_PICKERS.maxGlucoseAgeMinutes)} />
      <SettingInputSection copy={BUDDY_LIMIT_COPY.minAutoBolusIntervalMinutes} decimal={useLimit('minAutoBolusIntervalMinutes', GUARD_PICKERS.minAutoBolusIntervalMinutes)} />
    </SettingsScreen>
  );
}
