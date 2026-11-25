import { scheduleValueAt } from '@buddy/core';
import { Row, T } from '@/trio';
import { useLatestRun } from '@/runtime/hooks';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { useOrefBoolean } from '@/features/settings/bindings';
import { HintedSection } from '@/features/settings/components/setting-input-section';
import { FixedToggle, OrefDecimal } from '@/features/settings/components/oref-rows';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { fmtGlucoseValue } from '@/features/settings/picker';

const AUTOSENS_HINT = {
  label: 'Autosens',
  lines: [
    'Autosens automatically adjusts insulin delivery based on how sensitive or resistant you are to insulin at the time of the current loop cycle by analyzing past data to keep blood sugar levels stable.',
    '**How it Works',
    'It looks at the last 8-24 hours of data, excluding meal-related changes, and adjusts insulin settings like basal rates and targets when needed to match your sensitivity or resistance to insulin.',
    '**What it Adjusts',
    'Autosens modifies Insulin Sensitivity Factor (ISF), basal rates, and target glucose. It doesn’t account for carbs but adjusts for insulin effectiveness based on patterns in your glucose data.',
    '**Safety',
    'Autosens has safety limits determined by your Autosens Max and Autosens Min settings. These settings prevent over-adjusting.',
    'Autosens functions alongside certain settings, like Super Micro Bolus (SMB). Other settings, like Dynamic ISF, alter portions of the Autosens formula. Please review the in-app hints for the Algorithm Settings prior to enabling them to understand how they may influence it.',
  ],
};

/** Port of AutosensSettings.RootView. */
export default function AutosensSettings() {
  return (
    <SettingsScreen title="Autosens">
      <CurrentSensitivity />
      <OrefDecimal copy="autosensMax" settingKey="autosensMax" picker="autosensMax" />
      <OrefDecimal copy="autosensMin" settingKey="autosensMin" picker="autosensMin" />
      <FixedToggle copy="rewindResetsAutosens" value={false} />
    </SettingsScreen>
  );
}

function CurrentSensitivity() {
  const run = useLatestRun();
  const units = useSettings((s) => s.units);
  const profile = useSettings((s) => s.profile);
  const dynamic = useOrefBoolean('dynamicIsf').value;
  const ratio = run?.suggested?.sensitivityRatio;
  if (ratio === undefined || ratio <= 0) return null;
  const isf = scheduleValueAt(profile.isf, now(), profile.utcOffsetMinutes) / ratio;
  return (
    <HintedSection
      header={dynamic ? 'Dynamic Sensitivity' : 'Autosens'}
      miniHint="This adjusted ISF is temporary, will change with the next loop cycle, and should not be directly used as your profile ISF value."
      hint={AUTOSENS_HINT}>
      <Row>
        <T style={{ flex: 1 }}>Sensitivity Ratio</T>
        <T>{`${Math.round(ratio * 10000) / 100}%`}</T>
      </Row>
      <Row>
        <T style={{ flex: 1 }}>Calculated Sensitivity</T>
        <T>{fmtGlucoseValue(isf, units)}</T>
        <T secondary>{`${units}/U`}</T>
      </Row>
    </HintedSection>
  );
}
