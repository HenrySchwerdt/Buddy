/**
 * Explanatory copy for the delivery-limit and algorithm substeps, verbatim from Trio
 * (`DeliveryLimitSubstep.description` and `AlgorithmSettingsSubstep.description`) with
 * "Trio" → "Buddy". Rendered by `DescriptionBlocks`.
 */
import type { AlgorithmSubstep, DeliverySubstep } from './model';

export interface TextBlock {
  readonly text: string;
  readonly bold?: boolean;
  /** `primary` = `.foregroundStyle(.primary)`, otherwise the step's secondary footnote colour. */
  readonly color?: 'orange' | 'primary';
  readonly center?: boolean;
  /** Extra bottom padding (`.padding(.bottom)`). */
  readonly padBottom?: boolean;
}
/** A tight group of lines (SwiftUI `VStack(spacing: 0…5)`). */
export interface LineGroup {
  readonly lines: readonly (string | TextBlock)[];
  readonly center?: boolean;
}
export type Block = TextBlock | LineGroup;

/** Glucose value with units in the user's unit, e.g. "100 mg/dL" or "5.6 mmol/L". */
export type GlucoseText = (mgdl: number) => string;

export const DELIVERY_TITLES: Record<DeliverySubstep, { title: string; hint: string }> = {
  maxIOB: { title: 'Maximum Insulin on Board (IOB)', hint: 'Maximum units of insulin allowed to be active.' },
  maxBolus: { title: 'Maximum Bolus', hint: 'Largest bolus of insulin allowed.' },
  maxBasal: { title: 'Maximum Basal Rate', hint: 'Largest basal rate allowed.' },
  maxCOB: { title: 'Maximum Carbs on Board (COB)', hint: 'Maximum amount of active carbs considered by the algorithm.' },
  minimumSafetyThreshold: { title: 'Minimum Safety Threshold', hint: 'Increase the safety threshold used to suspend insulin delivery.' },
};

/** `g(v)` formats a glucose value without units, `u` is the unit label. */
export function deliveryDescription(step: DeliverySubstep, g: (mgdl: number) => string, u: string): Block[] {
  switch (step) {
    case 'maxIOB':
      return [
        { text: 'Default: 0 units', bold: true },
        { text: 'Note: This setting must be greater than 0 for any automatic insulin dosing by Buddy (unless you currently have negative IOB).', bold: true, color: 'orange' },
        { text: 'Choose a value that covers your highest insulin needs — think about a correction for a very high glucose reading plus your biggest meal bolus. This gives Buddy room to work while keeping you safe.' },
        { text: 'Max IOB sets a safety limit on how much insulin Buddy can automatically deliver above your scheduled basal rates. This prevents the system from giving too much insulin at once.' },
        {
          lines: [
            'Buddy calculates your current Insulin On Board (IOB) from:',
            '• Boluses (including SMBs)',
            '• Temporary Basal Rates (TBRs)',
            '  ◦ A TBR higher than your scheduled rate will increase IOB',
            '  ◦ A TBR lower than your scheduled rate will decrease IOB',
          ],
        },
        { text: 'If delivering more insulin would push your IOB above this limit, Buddy will reduce or skip the dose to stay within the safety boundary. This applies to SMBs, TBRs, and the recommendation from the bolus calculator.' },
        { lines: ["What's NOT limited:", '• Manual boluses you enter yourself', '• Manual temporary basal rates you set yourself'] },
      ];
    case 'maxBolus':
      return [
        { text: 'This is the maximum bolus allowed to be delivered at one time. This limits manual and automatic bolus.' },
        { text: 'Most set this to their largest meal bolus. Then, adjust if needed.' },
        { text: 'If you attempt to request a bolus larger than this, the bolus will not be accepted.' },
      ];
    case 'maxBasal':
      return [{ text: 'This is the maximum basal rate allowed to be set or scheduled. This applies to both automatic and manual basal rates.' }];
    case 'maxCOB':
      return [
        { text: 'This setting defines the maximum amount of Carbs On Board (COB) at any given time for Buddy to use in dosing calculations. If more carbs are entered than allowed by this limit, Buddy will cap the current COB in calculations to Max COB and remain at max until all remaining carbs have shown to be absorbed.' },
        { text: 'For example, if Max COB is 120 g and you enter a meal containing 150 g of carbs, your COB will remain at 120 g until the remaining 30 g have been absorbed.' },
        { text: 'This is an important limit when UAM is ON.' },
      ];
    case 'minimumSafetyThreshold':
      return [
        { text: 'Default: Set by Algorithm', bold: true },
        { text: 'Minimum Threshold Setting is, by default, determined by your set Glucose Target. This threshold automatically suspends insulin delivery if your glucose levels are forecasted to fall below this value. It’s designed to protect against hypoglycemia, particularly during sleep or other vulnerable times.' },
        { text: 'Buddy will use the larger of the default setting calculation below and the value entered here.' },
        { lines: [{ text: 'The default setting is based on this calculation:', bold: true }, 'TargetGlucose - 0.5 × (TargetGlucose - 40)'] },
        {
          lines: [
            `If your glucose target is ${g(110)} ${u}, Buddy will use a safety threshold of ${g(75)} ${u}, unless you set Minimum Safety Threshold to something > ${g(75)} ${u}.`,
            `${g(110)} - 0.5 × (${g(110)} - ${g(40)}) = ${g(75)}`,
          ],
        },
        { text: `This setting is limited to values between ${g(60)} - ${g(120)} ${u}` },
        { text: 'Note: Basal may be resumed if there is negative IOB and glucose is rising faster than the forecast.' },
      ];
  }
}

export function algorithmTitle(step: AlgorithmSubstep): string {
  return ALGORITHM_TITLES[step];
}

const ALGORITHM_TITLES: Record<AlgorithmSubstep, string> = {
  autosensMin: 'Autosens Minimum',
  autosensMax: 'Autosens Maximum',
  rewindResetsAutosens: 'Rewind Resets Autosens',
  enableSMBAlways: 'Enable SMB Always',
  enableSMBWithCOB: 'Enable SMB With COB',
  enableSMBWithTempTarget: 'Enable SMB With Temptarget',
  enableSMBAfterCarbs: 'Enable SMB After Carbs',
  enableSMBWithHighGlucoseTarget: 'Enable SMB With High Glucose',
  allowSMBWithHighTempTarget: 'Allow SMB With High Temptarget',
  enableUAM: 'Enable UAM (Unannounced Meals)',
  maxSMBMinutes: 'Max SMB Basal Minutes',
  maxUAMMinutes: 'Max UAM Basal Minutes',
  maxDeltaGlucoseThreshold: 'Max Allowed Glucose Rise for SMB',
  highTempTargetRaisesSensitivity: 'High Temp Target Raises Sensitivity',
  lowTempTargetLowersSensitivity: 'Low Temp Target Lowers Sensitivity',
  sensitivityRaisesTarget: 'Sensitivity Raises Target',
  resistanceLowersTarget: 'Resistance Lowers Target',
  halfBasalTarget: 'Half Basal Exercise Target',
};

export function algorithmHint(step: AlgorithmSubstep, gu: GlucoseText): string {
  switch (step) {
    case 'autosensMin':
      return 'Lower limit of the Autosens Ratio.';
    case 'autosensMax':
      return 'Upper limit of the Autosens Ratio.';
    case 'rewindResetsAutosens':
      return 'Pump rewind initiates a reset in Autosens Ratio.';
    case 'enableSMBAlways':
      return 'Allow SMBs at all times except when a high Temp Target is set.';
    case 'enableSMBWithCOB':
      return 'Allow SMB when carbs are on board.';
    case 'enableSMBWithTempTarget':
      return `Allow SMB when a manual Temporary Target is set under ${gu(100)}.`;
    case 'enableSMBAfterCarbs':
      return 'Allow SMB for 6 hrs after a carb entry.';
    case 'enableSMBWithHighGlucoseTarget':
      return 'Allow SMB when glucose is above the High Glucose Target value.';
    case 'allowSMBWithHighTempTarget':
      return `Allow SMB when a manual Temporary Target is set greater than ${gu(100)}.`;
    case 'enableUAM':
      return 'Enable Unannounced Meals SMB.';
    case 'maxSMBMinutes':
      return 'Limits the size of a single Super Micro Bolus (SMB) dose.';
    case 'maxUAMMinutes':
      return 'Limits the size of a single Unannounced Meal (UAM) SMB dose.';
    case 'maxDeltaGlucoseThreshold':
      return 'Disables SMBs if last two glucose values differ by more than this percent.';
    case 'highTempTargetRaisesSensitivity':
      return `Increase sensitivity when glucose is above target if a manual Temp Target > ${gu(100)} is set.`;
    case 'lowTempTargetLowersSensitivity':
      return `Decrease sensitivity when glucose is below target if a manual Temp Target < ${gu(100)} is set.`;
    case 'sensitivityRaisesTarget':
      return 'Raise target glucose when Autosens Ratio is less than 1.';
    case 'resistanceLowersTarget':
      return 'Lower target glucose when Autosens Ratio is greater than 1.';
    case 'halfBasalTarget':
      return 'Scales down your basal rate to 50% at this value.';
  }
}

const SMB_NOTE = 'Note: If this is enabled and the criteria are met, SMBs could be utilized regardless of other SMB settings being enabled or not.';
const def = (text: string): TextBlock => ({ text, bold: true, color: 'primary' });

export function algorithmDescription(step: AlgorithmSubstep, gu: GlucoseText): Block[] {
  switch (step) {
    case 'autosensMin':
      return [
        def('Default: 70%'),
        { text: 'Autosens Min sets the minimum Autosens Ratio used by Autosens, Dynamic ISF, and Sigmoid Formula.' },
        { text: 'The Autosens Ratio is used to calculate the amount of adjustment needed to basal rates, ISF, and CR.' },
        { text: 'Tip: Decreasing this value allows automatic adjustments of basal rates to be lower, ISF to be higher, and CR to be higher.' },
      ];
    case 'autosensMax':
      return [
        def('Default: 120%'),
        { text: 'Autosens Max sets the maximum Autosens Ratio used by Autosens, Dynamic ISF, and Sigmoid Formula.' },
        { text: 'The Autosens Ratio is used to calculate the amount of adjustment needed to basal rates, ISF, and CR.' },
        { text: 'Tip: Increasing this value allows automatic adjustments of basal rates to be higher, ISF to be lower, and CR to be lower.' },
      ];
    case 'rewindResetsAutosens':
      return [
        def('Default: ON'),
        { text: 'Medtronic and Dana Users Only', bold: true },
        { text: 'This feature resets the Autosens Ratio to neutral when you rewind your pump on the assumption that this corresponds to a site change.' },
        { text: 'Autosens will begin learning sensitivity anew from the time of the rewind, which may take up to 6 hours.' },
        { text: 'Tip: If you usually rewind your pump independently of site changes, you may want to consider disabling this feature.' },
      ];
    case 'enableSMBAlways':
      return [
        { text: 'Enabling SMB Always will disable some of the subsequent "Enable SMB" options during Onboarding. These redundant options will be skipped.', color: 'orange', padBottom: true },
        def('Default: OFF'),
        { text: 'When enabled, Super Micro Boluses (SMBs) will always be allowed if dosing calculations determine insulin is needed via the SMB delivery method, except when a high Temp Target is set.' },
        { text: 'Note: If you would like to allow SMBs when a high Temp Target is set, enable the "Allow SMBs with High Temptarget" setting.' },
      ];
    case 'enableSMBWithCOB':
      return [def('Default: OFF'), { text: 'When the carb on board (COB) forecast line is active, enabling this feature allows Buddy to use Super Micro Boluses (SMB) to deliver the insulin required.' }, { text: SMB_NOTE }];
    case 'enableSMBWithTempTarget':
      return [def('Default: OFF'), { text: `Enabling this feature allows Buddy to deliver insulin required using Super Micro Boluses (SMB) at times when a manual Temporary Target under ${gu(100)} is set.` }, { text: SMB_NOTE }];
    case 'enableSMBAfterCarbs':
      return [def('Default: OFF'), { text: 'Enabling this feature allows Buddy to deliver insulin required using Super Micro Boluses (SMB) for 6 hours after a carb entry, regardless of whether there are active carbs on board (COB).' }, { text: SMB_NOTE }];
    case 'enableSMBWithHighGlucoseTarget':
      return [def('Default: OFF'), { text: 'Enabling this feature allows Buddy to deliver insulin required using Super Micro Boluses (SMB) when glucose reading is above the value set as High Glucose Target.' }, { text: SMB_NOTE }];
    case 'allowSMBWithHighTempTarget':
      return [
        def('Default: OFF'),
        { text: `Enabling this feature allows Buddy to deliver insulin required using Super Micro Boluses (SMB) when a manual Temporary Target above ${gu(100)} is set.` },
        { text: SMB_NOTE },
        { text: 'Warning: High Temp Targets are often set when recovering from lows. If you use High Temp Targets for that purpose, this feature should remain disabled.', bold: true },
      ];
    case 'enableUAM':
      return [
        def('Default: OFF'),
        { text: 'Enabling the UAM (Unannounced Meals) feature allows the system to detect and respond to unexpected rises in glucose readings caused by unannounced or miscalculated carbs, meals high in fat or protein, or other factors like adrenaline.' },
        { text: 'It uses the SMB (Super Micro Bolus) algorithm to deliver insulin in small amounts to correct glucose spikes. UAM also works in reverse, reducing or stopping SMBs if glucose levels drop unexpectedly.' },
        { text: 'This feature ensures more accurate insulin adjustments when carb entries are missing or incorrect.' },
      ];
    case 'maxSMBMinutes':
      return basalMinutes('SMB', 'Max SMB Basal Minutes', 90, 'Note: SMBs must be enabled to use this limit.');
    case 'maxUAMMinutes':
      return basalMinutes('UAM SMB', 'Max UAM SMB Basal Minutes', 60, 'Note: UAM SMBs must be enabled to use this limit.');
    case 'maxDeltaGlucoseThreshold':
      return [
        def('Default: 20% increase'),
        { text: 'Maximum allowed positive percent change in glucose level to permit SMBs. If the difference in glucose is greater than this, Buddy will only adjust Temp Basal Rate and not deliver an SMB that loop cycle.' },
        { text: 'This is a safety limitation to avoid high SMB doses when glucose is rising abnormally fast, such as after a meal or with a very jumpy CGM sensor.' },
        { text: 'Note: This setting has a hard-coded cap of 40%' },
      ];
    case 'highTempTargetRaisesSensitivity':
      return [
        def('Default: OFF'),
        { text: `When this feature is enabled, manually setting a temporary target above ${gu(100)} will decrease the Autosens Ratio used for ISF and basal adjustments, resulting in less insulin delivered overall. This scales with the temporary target set; the higher the temp target, the lower the Autosens Ratio used.` },
        { text: `If Half Basal Exercise Target is set to ${gu(160)}, a temp target of ${gu(120)} uses an Autosens Ratio of 0.75. A temp target of ${gu(140)} uses an Autosens Ratio of 0.6.` },
        { text: 'Note: The effect of this can be adjusted with the Half Basal Exercise Target' },
      ];
    case 'lowTempTargetLowersSensitivity':
      return [
        def('Default: OFF'),
        { text: `When this feature is enabled, setting a temporary target below ${gu(100)} will increase the Autosens Ratio used for ISF and basal adjustments, resulting in more insulin delivered overall. This scales with the temporary target set; the lower the Temp Target, the higher the Autosens Ratio used. It requires Algorithm Settings > Autosens > Autosens Max to be set to > 100% to work.` },
        { text: `If Half Basal Exercise Target is ${gu(160)}, a Temp Target of ${gu(95)} uses an Autosens Ratio of 1.09. A Temp Target of ${gu(85)} uses an Autosens Ratio of 1.33.` },
        { text: 'Note: The effect of this can be adjusted with the Half Basal Exercise Target' },
      ];
    case 'sensitivityRaisesTarget':
      return [def('Default: OFF'), { text: 'Enabling this feature causes Buddy to automatically raise the targeted glucose if it detects an increase in insulin sensitivity from your baseline.' }];
    case 'resistanceLowersTarget':
      return [def('Default: OFF'), { text: 'Enabling this feature causes Buddy to automatically reduce the targeted glucose if it detects a decrease in sensitivity (resistance) from your baseline.' }];
    case 'halfBasalTarget':
      return [
        def(`Default: ${gu(160)}`),
        { text: 'The Half Basal Exercise Target allows you to scale down your basal insulin during exercise or scale up your basal insulin when eating soon when a temporary glucose target is set.' },
        { text: `For example, at a temp target of ${gu(160)}, your basal is reduced to 50%, but this scales depending on the target (e.g., 75% at ${gu(120)}, 60% at ${gu(140)}).` },
        { text: 'Note: This setting is only utilized if the settings "Low Temp Target Lowers Sensitivity" OR "High Temp Target Raises Sensitivity" are enabled.' },
      ];
  }
}

function basalMinutes(kind: string, symbol: string, warnAbove: number, note: string): Block[] {
  return [
    def('Default: 30 minutes'),
    { text: '(50% current basal rate)' },
    { text: `This is a limit on the size of a single ${kind}. One ${kind} can only be as large as this many minutes of your current profile basal rate.` },
    { text: `To calculate the maximum ${kind} allowed based on this setting, use the following formula:` },
    { lines: [`𝒳 = ${symbol}`, '(𝒳 / 60) × current basal rate'], center: true },
    { text: `Warning: Increasing this value above ${warnAbove} minutes may impact Buddy's ability to effectively zero temp and prevent lows.`, bold: true },
    { text: note },
  ];
}
