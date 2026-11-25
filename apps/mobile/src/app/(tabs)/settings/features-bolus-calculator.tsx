import { useSettings } from '@/runtime/settings-store';
import { useTreatmentBoolean, useTreatmentDecimal } from '@/features/settings/bindings';
import { SettingInputSection } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { PICKERS } from '@/features/settings/picker';
import { TRIO_COPY } from '@/features/settings/trio-copy';

/** Port of BolusCalculatorConfig.RootView. "Recommended Bolus Percentage" is Buddy's bolusFraction. */
export default function BolusCalculatorSettings() {
  const bolusFraction = useSettings((s) => s.bolusFraction);
  const update = useSettings((s) => s.update);
  return (
    <SettingsScreen title="Bolus Calculator">
      <SettingInputSection copy={TRIO_COPY.displayPresets} boolean={useTreatmentBoolean('displayPresets')} />
      <SettingInputSection copy={TRIO_COPY.overrideFactor} decimal={{ value: bolusFraction, onChange: (v) => update({ bolusFraction: v }), picker: PICKERS.overrideFactor }} />
      <SettingInputSection copy={TRIO_COPY.fattyMeals} boolean={useTreatmentBoolean('fattyMeals')} decimal={useTreatmentDecimal('fattyMealFactor', 'fattyMealFactor')} />
      <SettingInputSection copy={TRIO_COPY.sweetMeals} boolean={useTreatmentBoolean('sweetMeals')} decimal={useTreatmentDecimal('sweetMealFactor', 'sweetMealFactor')} />
      <SettingInputSection copy={TRIO_COPY.confirmBolusWhenVeryLowGlucose} boolean={useTreatmentBoolean('confirmBolus')} />
    </SettingsScreen>
  );
}
