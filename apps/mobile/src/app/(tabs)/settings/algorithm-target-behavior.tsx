import { OrefDecimal, OrefToggle } from '@/features/settings/components/oref-rows';
import { SettingsScreen } from '@/features/settings/components/settings-screen';

/** Port of TargetBehavoir.RootView, bound to the oref plugin's Target Behavior keys. */
export default function TargetBehavior() {
  return (
    <SettingsScreen title="Target Behavior">
      <OrefToggle copy="highTemptargetRaisesSensitivity" settingKey="highTempTargetRaisesSensitivity" />
      <OrefToggle copy="lowTemptargetLowersSensitivity" settingKey="lowTempTargetLowersSensitivity" />
      <OrefToggle copy="sensitivityRaisesTarget" settingKey="sensitivityRaisesTarget" />
      <OrefToggle copy="resistanceLowersTarget" settingKey="resistanceLowersTarget" />
      <OrefDecimal copy="halfBasalExerciseTarget" settingKey="halfBasalExerciseTarget" picker="halfBasalExerciseTarget" />
    </SettingsScreen>
  );
}
