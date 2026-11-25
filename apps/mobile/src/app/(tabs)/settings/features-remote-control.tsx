import { fixedBoolean } from '@/features/settings/bindings';
import { SettingInputSection } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { TRIO_COPY } from '@/features/settings/trio-copy';

/** Port of RemoteControlConfig. Buddy does not accept remote commands; the switch stays off. */
export default function RemoteControlSettings() {
  return (
    <SettingsScreen title="Remote Control">
      <SettingInputSection copy={TRIO_COPY.isTrioRemoteControlEnabled} boolean={fixedBoolean(false)} disabled note="Buddy does not accept remote commands." />
    </SettingsScreen>
  );
}
