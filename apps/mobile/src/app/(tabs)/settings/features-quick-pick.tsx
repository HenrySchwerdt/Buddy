import { usePrefBoolean } from '@/features/settings/bindings';
import { SettingInputSection } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { TRIO_COPY } from '@/features/settings/trio-copy';

/** Port of QuickPickTreatmentsConfig.RootView. Long-pressing the + button opens the picker (features/home/quick-pick-sheet). */
export default function QuickPickSettings() {
  return (
    <SettingsScreen title="Quick-Pick Treatments">
      <SettingInputSection copy={TRIO_COPY.enableQuickPickTreatments} boolean={usePrefBoolean('enableQuickPickTreatments')} />
    </SettingsScreen>
  );
}
