import { PickerRow } from '@/trio';
import { useOrefBoolean } from '@/features/settings/bindings';
import { HintedSection } from '@/features/settings/components/setting-input-section';
import { FixedDecimal, FixedToggle, OrefDecimal } from '@/features/settings/components/oref-rows';
import { SettingsScreen } from '@/features/settings/components/settings-screen';

type DynamicType = 'disabled' | 'logarithmic';

/** Trio also offers "Sigmoid"; Buddy's oref adapter only implements the logarithmic formula. */
const OPTIONS: readonly { value: DynamicType; label: string }[] = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'logarithmic', label: 'Logarithmic' },
];

const DYNAMIC_HINT = {
  label: 'Dynamic Insulin Sensitivity',
  lines: [
    '**Default: Disabled',
    'Enabling this feature allows Trio to calculate a new Insulin Sensitivity Factor with each loop cycle dynamically. Trio offers two dynamic formulas:',
    '**Logarithmic Dynamic ISF',
    'Enabling this feature allows Trio to calculate a new Insulin Sensitivity Factor with each loop cycle by considering your current glucose, the weighted total daily dose of insulin, the set adjustment factor, and a few other data points. This helps tailor your insulin response more accurately in real time.',
    'Dynamic ISF produces a Dynamic Ratio, replacing the Autosens Ratio, determining how much your profile ISF will be adjusted every loop cycle, ensuring it stays within safe limits set by your Autosens Min/Max settings. It provides more precise insulin dosing by responding to changes in insulin needs throughout the day.',
    "You can influence the adjustments made by Dynamic ISF primarily by adjusting Autosens Max, Autosens Min, and Adjustment Factor. Other settings also influence Dynamic ISF's response, such as Glucose Target, Profile ISF, Peak Insulin Time, and Weighted Average of TDD.",
    '**Warning: Before adjusting these settings, make sure you are fully aware of the impact those changes will have.',
    '**Sigmoid Dynamic ISF',
    'Buddy does not implement the Sigmoid formula yet.',
  ],
};

/** Port of DynamicSettings.RootView. */
export default function DynamicSettings() {
  const dynamic = useOrefBoolean('dynamicIsf');
  const type: DynamicType = dynamic.value ? 'logarithmic' : 'disabled';
  return (
    <SettingsScreen title="Dynamic Settings">
      <HintedSection header="Dynamic Insulin Sensitivity" miniHint="Dynamically adjust insulin sensitivity using Dynamic Ratio rather than Autosens Ratio." hint={DYNAMIC_HINT}>
        <PickerRow label="Dynamic ISF" value={type} options={OPTIONS} onChange={(v) => dynamic.onChange(v === 'logarithmic')} />
      </HintedSection>
      {dynamic.value ? (
        <>
          <OrefDecimal copy="adjustmentFactor" settingKey="adjustmentFactor" picker="adjustmentFactor" />
          <FixedDecimal copy="weightPercentage" value={0.65} picker="weightPercentage" />
          <FixedToggle copy="tddAdjBasal" value={false} />
        </>
      ) : null}
    </SettingsScreen>
  );
}
