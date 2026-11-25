import { DEFAULT_PEAK_MINUTES } from '@buddy/core';
import { useSettings } from '@/runtime/settings-store';
import { SettingInputSection } from '@/features/settings/components/setting-input-section';
import { FixedDecimal, FixedToggle, OrefDecimal, OrefToggle } from '@/features/settings/components/oref-rows';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { PICKERS } from '@/features/settings/picker';
import { TRIO_COPY } from '@/features/settings/trio-copy';

/** Port of AlgorithmAdvancedSettings.RootView. DIA and peak time live in Buddy's therapy profile. */
export default function Additionals() {
  const profile = useSettings((s) => s.profile);
  const update = useSettings((s) => s.update);
  const setProfile = (patch: Partial<typeof profile>) => update({ profile: { ...useSettings.getState().profile, ...patch } });
  const customPeak = profile.insulinPeakMinutes !== undefined;
  return (
    <SettingsScreen title="Additionals">
      <FixedDecimal copy="maxDailySafetyMultiplier" value={3} picker="maxDailySafetyMultiplier" />
      <FixedDecimal copy="currentBasalSafetyMultiplier" value={4} picker="currentBasalSafetyMultiplier" />
      <SettingInputSection copy={TRIO_COPY.insulinActionCurve} decimal={{ value: profile.diaHours, onChange: (v) => setProfile({ diaHours: v }), picker: PICKERS.dia }} />
      <SettingInputSection
        copy={TRIO_COPY.useCustomPeakTime}
        boolean={{ value: customPeak, onChange: (on) => setProfile({ insulinPeakMinutes: on ? DEFAULT_PEAK_MINUTES[profile.insulinCurve] : undefined }) }}
        decimal={{ value: profile.insulinPeakMinutes ?? DEFAULT_PEAK_MINUTES[profile.insulinCurve], onChange: (v) => setProfile({ insulinPeakMinutes: v }), picker: PICKERS.insulinPeakTime }}
      />
      <OrefToggle copy="skipNeutralTemps" settingKey="skipNeutralTemps" />
      <FixedToggle copy="unsuspendIfNoTemp" value={false} />
      <OrefDecimal copy="smbDeliveryRatio" settingKey="smbDeliveryRatio" picker="smbDeliveryRatio" />
      <OrefDecimal copy="smbInterval" settingKey="smbInterval" picker="smbInterval" />
      <OrefDecimal copy="min5mCarbimpact" settingKey="min5mCarbImpact" picker="min5mCarbimpact" />
      <FixedDecimal copy="remainingCarbsFraction" value={1} picker="remainingCarbsFraction" />
      <OrefDecimal copy="remainingCarbsCap" settingKey="remainingCarbsCap" picker="remainingCarbsCap" />
      <FixedDecimal copy="noisyCGMTargetMultiplier" value={1.3} picker="noisyCGMTargetMultiplier" />
    </SettingsScreen>
  );
}
