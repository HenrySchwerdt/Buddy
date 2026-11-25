import { View } from 'react-native';
import { PickerRow, ToggleRow } from '@/trio';
import { useSettings, type Appearance } from '@/runtime/settings-store';
import { usePrefBoolean, usePrefDecimal } from '@/features/settings/bindings';
import { DecimalLine, HintedSection, SettingInputSection } from '@/features/settings/components/setting-input-section';
import { SettingsScreen } from '@/features/settings/components/settings-screen';
import { fmtGlucoseValue } from '@/features/settings/picker';
import { useTrioPrefs, type TrioPrefs } from '@/features/settings/store';
import { TRIO_COPY } from '@/features/settings/trio-copy';

const APPEARANCE: readonly { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System Default' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const COLOR_SCHEME = [
  { value: 'dynamicColor', label: 'Dynamic' },
  { value: 'staticColor', label: 'Static' },
] as const;
const FORECAST = [
  { value: 'cone', label: 'Cone' },
  { value: 'lines', label: 'Lines' },
] as const;
const BOLUS_THRESHOLD = [
  { value: 1, label: '1 U and over' },
  { value: 0.5, label: '0.5 U and over' },
  { value: 0.1, label: '0.1 U and over' },
  { value: 0.01, label: 'Show All' },
] as const;
const A1C_UNIT = [
  { value: 'percent', label: 'Percent' },
  { value: 'mmolMol', label: 'mmol/mol' },
] as const;
const STATS_FACE = [
  { value: 'timeInRange', label: 'Time in Range' },
  { value: 'distributionBar', label: 'Distribution Bar Only' },
  { value: 'averages', label: 'Averages' },
  { value: 'hidden', label: 'Hide Statistics' },
] as const;
const STATS_RANGE = [
  { value: 'today', label: 'Today' },
  { value: 'day', label: 'Last 24 Hours' },
  { value: 'week', label: 'Last 7 Days' },
  { value: 'month', label: 'Last Month' },
  { value: 'threeMonths', label: 'Last 3 Months' },
] as const;

function usePref<K extends keyof TrioPrefs>(key: K): [TrioPrefs[K], (v: TrioPrefs[K]) => void] {
  const value = useTrioPrefs((s) => s[key]);
  const set = useTrioPrefs((s) => s.set);
  return [value, (v) => set({ [key]: v } as Partial<TrioPrefs>)];
}

/** Port of UserInterfaceSettings.RootView. Values other than Appearance are display preferences for the Home and Statistics screens. */
export default function UserInterfaceSettings() {
  const appearance = useSettings((s) => s.appearance);
  const units = useSettings((s) => s.units);
  const update = useSettings((s) => s.update);
  const [colorScheme, setColorScheme] = usePref('glucoseColorScheme');
  const [xGrid, setXGrid] = usePref('xGridLines');
  const [yGrid, setYGrid] = usePref('yGridLines');
  const [forecast, setForecast] = usePref('forecastDisplayType');
  const [bolusThreshold, setBolusThreshold] = usePref('bolusDisplayThreshold');
  const [a1c, setA1c] = usePref('eA1cDisplayUnit');
  const [tir, setTir] = usePref('timeInRangeType');
  const [face, setFace] = usePref('homeStatsPanelFace');
  const [range, setRange] = usePref('homeStatsPanelRange');
  const rulerMarks = usePrefBoolean('rulerMarks');
  const low = usePrefDecimal('low', 'low');
  const high = usePrefDecimal('high', 'high');
  const g = (mgdl: number) => `${fmtGlucoseValue(mgdl, units)} ${units}`;
  const tirOptions = [
    { value: 'timeInTightRange', label: `Standard (${g(70)})` },
    { value: 'timeInNormoglycemia', label: `Extended (${g(63)})` },
  ] as const;

  return (
    <SettingsScreen title="User Interface">
      <HintedSection
        header="General Appearance"
        miniHint="Choose Trio's appearance. See hint for more details."
        hint={{ label: 'Appearance', lines: ["Sets Trio's appearance. Descriptions of each option found below.", '**System Default:', "Follows the phone's current color scheme setting at that time", '**Light:', 'Always in Light mode', '**Dark:', 'Always in Dark mode'] }}>
        <PickerRow label="Appearance" value={appearance} options={APPEARANCE} onChange={(v) => update({ appearance: v })} />
      </HintedSection>
      <HintedSection
        miniHint="Choose glucose reading color scheme. See hint for more details."
        hint={{
          label: 'Glucose Color Scheme',
          lines: [
            'Set the color scheme for glucose readings on the main glucose graph, live activities, and bolus calculator. Descriptions for each option found below.',
            '**Dynamic (Default):',
            'Green = At Target',
            'Gradient Red = As readings approach and exceed below target, they gradually become more red.',
            'Gradient Purple = As readings approach and exceed above target, they become more purple.',
            '**Static:',
            'Red = Below Range',
            'Green = In Range',
            'Purple = Above Range',
          ],
        }}>
        <PickerRow label="Glucose Color Scheme" value={colorScheme} options={COLOR_SCHEME} onChange={setColorScheme} />
      </HintedSection>
      <HintedSection header="Home View Settings" miniHint="Display the grid lines behind the glucose graph." hint={{ label: 'Show Main Chart Grid Lines', lines: ['Choose whether or not to display one or both X- and Y-Axis grid lines.'] }}>
        <ToggleRow label="Show X-Axis Grid Lines" value={xGrid} onChange={setXGrid} />
        <ToggleRow label="Show Y-Axis Grid Lines" value={yGrid} onChange={setYGrid} />
      </HintedSection>
      <SettingInputSection copy={TRIO_COPY.rulerMarks} boolean={rulerMarks} />
      {rulerMarks.value ? (
        <HintedSection
          miniHint="Set low and high glucose values for the main screen, watch app, live activity, and contact image colors."
          hint={{
            label: 'Low and High Thresholds',
            lines: [
              '**Default values are based on internationally accepted Time in Range values of {g:70}-{g:180} {unit}.',
              'These thresholds drive the chart band colors, statistics in-range buckets, Live Activity colors, and Contact Image colors.',
              'To configure when alarms fire (urgent low / low / high / forecasted low), open Glucose Alarms.',
              'Note: These values are not used to calculate insulin dosing.',
            ],
          }}>
          <View>
            <DecimalLine label="Low Threshold" binding={low} />
            <DecimalLine label="High Threshold" binding={high} />
          </View>
        </HintedSection>
      ) : null}
      <HintedSection
        miniHint="Choose glucose forecast presentation. See hint for more details."
        hint={{
          label: 'Forecast Display Type',
          lines: [
            'This setting allows you to choose between Cone of Uncertainty (Cone) and OpenAPS Forecast Lines (Forecast Lines) for the glucose forecast. Descriptions for each option found below.',
            '**Cone:',
            'Uses a combined range of all possible forecasts from the OpenAPS lines and provides you with a range of possible forecasts. This option has shown to reduce confusion and stress around algorithm forecasts by providing a less concerning visual representation.',
            '**Forecast Lines:',
            "Uses the IOB, COB, UAM, and ZT forecast lines from OpenAPS. This option provides a more detailed view of the algorithm's forecast, but may be more confusing for some users.",
          ],
        }}>
        <PickerRow label="Forecast Display Type" value={forecast} options={FORECAST} onChange={setForecast} />
      </HintedSection>
      <HintedSection
        miniHint="Choose to hide small bolus amounts. See hint for more details."
        hint={{
          label: 'Bolus Display Threshold',
          lines: [
            'This setting controls which bolus amount labels are shown on Trio’s main chart. Boluses appear as blue upside-down triangles, with a number showing the amount. Depending on the option you choose, only boluses at or above that amount will show a label. For example, if you choose ‘0.5 U and over’, only boluses of 0.5 U or more will show a label.',
          ],
        }}>
        <PickerRow label="Bolus Display Threshold" value={bolusThreshold} options={BOLUS_THRESHOLD} onChange={setBolusThreshold} />
      </HintedSection>
      <HintedSection
        header="Buddy Statistics"
        miniHint="Choose to display eA1c and GMI in percent or mmol/mol."
        hint={{
          label: 'eA1c/GMI Display Unit',
          lines: [
            "Choose which format you'd prefer the eA1c (estimated A1c) and GMI (Glucose Management Index) value in the statistics view as a percentage (Example: eA1c: 6.5%) or mmol/mol (Example: eA1c: 48 mmol/mol).",
          ],
        }}>
        <PickerRow label="eA1c/GMI Display Unit" value={a1c} options={A1C_UNIT} onChange={setA1c} />
      </HintedSection>
      <HintedSection
        miniHint="Choose the preferred lower threshold for Time in Range statistics."
        hint={{
          label: 'TIR Lower Threshold',
          lines: [
            `Choose the preferred lower threshold for Time in Range statistics across all charts and displays. This applies to both Time in Range (TIR, upper threshold of ${g(180)}) and Time in Tight Range (TITR, upper threshold of ${g(140)}).`,
            '**Standard:',
            `Uses the established lower threshold of ${g(70)}.`,
            '**Extended:',
            `Uses the newer Time in Normoglycemia (TING) lower threshold of ${g(63)}.`,
          ],
        }}>
        <PickerRow label="TIR Lower Threshold" value={tir} options={tirOptions} onChange={setTir} />
      </HintedSection>
      <HintedSection
        miniHint="Choose what the statistics panel on the home screen displays."
        hint={{
          label: 'Home Statistics Panel',
          lines: [
            'Choose what the statistics panel on the home screen shows by default. Tapping the panel always opens the full statistics view.\n\nTime in Range: your time in range percentage with a glucose distribution bar.\n\nDistribution Bar Only: just the glucose distribution bar, without the percentage.\n\nAverages: your average glucose and GMI (Glucose Management Index).\n\nHide Statistics: shows no data at all, just a "View Statistics" shortcut.\n\nThe numbers cover the time span set in Home Statistics Range.',
          ],
        }}>
        <PickerRow label="Home Statistics Panel" value={face} options={STATS_FACE} onChange={setFace} />
      </HintedSection>
      <HintedSection
        miniHint="Choose the time span the home statistics panel covers."
        hint={{
          label: 'Home Statistics Range',
          lines: [
            'Choose how far back the statistics panel on the home screen looks. The full statistics view opens on the same time span.\n\nToday: from midnight until now.\n\nLast 24 Hours: the past 24 hours.\n\nLast 7 Days: the past 7 days.\n\nLast Month: the past month.\n\nLast 3 Months: the past 3 months.\n\nThe panel\'s wording follows your choice, for example "Time in Range last 7 days".',
          ],
        }}>
        <PickerRow label="Home Statistics Range" value={range} options={STATS_RANGE} onChange={setRange} />
      </HintedSection>
      <SettingInputSection copy={TRIO_COPY.showCarbsRequiredBadge} boolean={usePrefBoolean('showCarbsRequiredBadge')} decimal={usePrefDecimal('carbsRequiredThreshold', 'carbsRequiredThreshold')} />
      <SettingInputSection copy={TRIO_COPY.requireAdjustmentsConfirmation} boolean={usePrefBoolean('requireAdjustmentsConfirmation')} />
    </SettingsScreen>
  );
}
