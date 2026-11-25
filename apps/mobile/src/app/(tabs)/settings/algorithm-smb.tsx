import { useOrefBoolean } from '@/features/settings/bindings';
import { FixedDecimal, FixedToggle, OrefConditional, OrefDecimal, OrefToggle } from '@/features/settings/components/oref-rows';
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
          <FixedToggle copy="enableSMBWithTemptarget" value={false} />
          <OrefToggle copy="enableSMBAfterCarbs" settingKey="enableSMBAfterCarbs" />
          <OrefConditional copy="enableSMB_high_bg" boolKey="enableSMBHighBg" decimalKey="enableSMBHighBgTarget" picker="enableSMB_high_bg_target" />
        </>
      )}
      <FixedToggle copy="allowSMBWithHighTemptarget" value={false} />
      <OrefToggle copy="enableUAM" settingKey="enableUAM" />
      <OrefDecimal copy="maxSMBBasalMinutes" settingKey="maxSMBBasalMinutes" picker="maxSMBBasalMinutes" />
      <OrefDecimal copy="maxUAMSMBBasalMinutes" settingKey="maxUAMSMBBasalMinutes" picker="maxUAMSMBBasalMinutes" />
      <FixedDecimal copy="maxDeltaBGthreshold" value={0.2} picker="maxDeltaBGthreshold" />
    </SettingsScreen>
  );
}
