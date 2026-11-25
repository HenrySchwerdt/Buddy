import { StyleSheet, View } from 'react-native';
import { useTreatmentBoolean, useTreatmentDecimal, usePrefDecimal, NOT_USED_NOTE } from '@/features/settings/bindings';
import { DecimalLine, HintedSection, SettingInputSection } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { TRIO_COPY } from '@/features/settings/trio-copy';

const LIMITS_HINT = {
  label: 'Limits per Entry',
  lines: ['**Max Carbs:', 'Enter the largest carb value allowed per meal entry', '**Max Fat:', 'Enter the largest fat value allowed per meal entry', '**Max Protein:', 'Enter the largest protein value allowed per meal entry'],
};

/** Port of MealSettings.RootView. */
export default function MealSettings() {
  const fpu = useTreatmentBoolean('useFPUconversion');
  const maxCarbs = useTreatmentDecimal('maxCarbs', 'maxCarbs');
  const maxFat = useTreatmentDecimal('maxFat', 'maxFat');
  const maxProtein = useTreatmentDecimal('maxProtein', 'maxProtein');
  return (
    <SettingsScreen title="Meal Settings">
      <HintedSection header="Limits per Entry" miniHint="Set limits for each type of macro per meal entry." hint={LIMITS_HINT}>
        <View style={styles.lines}>
          <DecimalLine label="Max Carbs" binding={maxCarbs} />
          {fpu.value ? <DecimalLine label="Max Fat" binding={maxFat} /> : null}
          {fpu.value ? <DecimalLine label="Max Protein" binding={maxProtein} /> : null}
        </View>
      </HintedSection>
      <SettingInputSection copy={TRIO_COPY.maxMealAbsorptionTime} decimal={usePrefDecimal('maxMealAbsorptionTime', 'maxMealAbsorptionTime')} note={NOT_USED_NOTE} />
      <SettingInputSection copy={TRIO_COPY.useFPUconversion} boolean={fpu} />
      {fpu.value ? (
        <>
          <SettingInputSection copy={TRIO_COPY.delay} decimal={useTreatmentDecimal('delay', 'delay')} />
          <SettingInputSection copy={TRIO_COPY.minuteInterval} decimal={useTreatmentDecimal('minuteInterval', 'minuteInterval')} />
          <SettingInputSection copy={TRIO_COPY.individualAdjustmentFactor} decimal={useTreatmentDecimal('individualAdjustmentFactor', 'individualAdjustmentFactor')} />
        </>
      ) : null}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  lines: { paddingTop: 4 },
});
