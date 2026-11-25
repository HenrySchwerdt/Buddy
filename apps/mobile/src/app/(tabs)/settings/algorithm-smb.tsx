import { useOrefBoolean } from '@/features/settings/bindings';
import { OrefConditional, OrefDecimal, OrefToggle } from '@/features/settings/components/oref-rows';
import { SettingsScreen } from '@/features/settings/components/settings-screen';

/** Port of SMBSettings.RootView. */
export default function SMBSettings() {
  const always = useOrefBoolean('enableSMBAlways').value;
  return (
    <SettingsScreen title="SMB Settings">
      <OrefToggle copy="enableSMBAlways" settingKey="enableSMBAlways" />
      {always ? null : (
        <>
          <OrefToggle copy="enableSMBWithCOB" settingKey="enableSMBWithCOB" />
          <OrefToggle copy="enableSMBWithTemptarget" settingKey="enableSMBWithTempTarget" />
          <OrefToggle copy="enableSMBAfterCarbs" settingKey="enableSMBAfterCarbs" />
          <OrefConditional copy="enableSMB_high_bg" boolKey="enableSMBHighBg" decimalKey="enableSMBHighBgTarget" picker="enableSMB_high_bg_target" />
        </>
      )}
      <OrefToggle copy="allowSMBWithHighTemptarget" settingKey="allowSMBWithHighTempTarget" />
      <OrefToggle copy="enableUAM" settingKey="enableUAM" />
      <OrefDecimal copy="maxSMBBasalMinutes" settingKey="maxSMBBasalMinutes" picker="maxSMBBasalMinutes" />
      <OrefDecimal copy="maxUAMSMBBasalMinutes" settingKey="maxUAMSMBBasalMinutes" picker="maxUAMSMBBasalMinutes" />
      <OrefDecimal copy="maxDeltaBGthreshold" settingKey="maxDeltaBGThreshold" picker="maxDeltaBGthreshold" />
    </SettingsScreen>
  );
}
