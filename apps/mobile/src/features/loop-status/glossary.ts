/** LoopStatusHelpView glossary (terms of oref's `reason`), copy as in Trio with "Trio" -> "Buddy". */
export type GlossaryColor = 'insulin' | 'zt' | 'green' | 'gray';

export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
  readonly color: GlossaryColor;
}

export const GLOSSARY_INTRO =
  "The oref algorithm provides recommendations, showing key variables, decisions on temporary basal rates or super-micro-boluses, and a 'reason' field explaining its actions. Find all key terms of this 'reason' explained below:";

export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: 'Autosens Ratio', definition: 'The ratio of how sensitive or resistant to insulin you are in the current loop cycle. Baseline = 1.0, Sensitive < 1.0, Resistant > 1.0', color: 'insulin' },
  { term: 'ISF', definition: 'The first value is your profile Insulin Sensitivity Factor (ISF). The second value, after the arrow, is your adjusted ISF used for the most recent automated dosing calculation.', color: 'insulin' },
  { term: 'COB', definition: 'Amount of Carbs on Board (COB) used in the most recent automated dosing calculation.', color: 'insulin' },
  { term: 'Dev', definition: "Abbreviation for 'Deviation'. How much the actual glucose change deviated from the BGI.", color: 'insulin' },
  { term: 'BGI', definition: 'The degree to which your glucose should be rising or falling based solely on insulin activity.', color: 'insulin' },
  { term: 'CR', definition: 'The first value is your profile Carb Ratio (CR). The second value, after the arrow, is your adjusted CR used for the most recent automated dosing calculation.', color: 'insulin' },
  {
    term: 'Target',
    definition:
      'The first value is your target glucose from your settings. The second value, after the arrow, is your adjusted target glucose used for the most recent automated dosing calculation. A second value is shown if you have a temp target, override, or one of the Target Behavior options enabled.',
    color: 'insulin',
  },
  { term: 'minPredBG', definition: 'The lowest forecasted value that Buddy has estimated for your future glucose.', color: 'insulin' },
  { term: 'minGuardBG', definition: 'The lowest forecasted glucose during the remaining duration of insulin action (DIA).', color: 'insulin' },
  { term: 'IOBpredBG', definition: 'The forecasted glucose value in 4 hours calculated based on IOB only.', color: 'insulin' },
  { term: 'COBpredBG', definition: 'The forecasted glucose value in 4 hours calculated based on current IOB and COB.', color: 'insulin' },
  { term: 'UAMpredBG', definition: 'The forecasted glucose value in 4 hours based on current deviations ramping down to zero at the same rate they have been recently.', color: 'insulin' },
  { term: 'TDD', definition: "Abbreviation for 'Total Daily Dose'. Last 24 hours of total insulin administered, both basal and bolus.", color: 'zt' },
  { term: 'Bolus/Basal %', definition: 'Of the total insulin delivered in the past 24 hours, this indicates what percentage was administered through basals and what was given through bolus.', color: 'green' },
  { term: 'Dynamic ISF/CR', definition: 'A display of On/On indicates both Dynamic ISF and CR are enabled. On/Off indicates only Dynamic ISF is enabled. Dynamic CR cannot be enabled when Dynamic ISF is disabled.', color: 'zt' },
  { term: 'Sigmoid function', definition: 'If shown, Sigmoid Dynamic ISF is enabled.', color: 'zt' },
  { term: 'Logarithmic formula', definition: 'If shown, Logarithmic Dynamic ISF is enabled.', color: 'zt' },
  { term: 'AF', definition: 'Displays the Adjustment Factor (AF) for either Logarithmic or Sigmoid Dynamic ISF in use.', color: 'zt' },
  { term: 'SMB Ratio', definition: 'SMB Delivery Ratio of calculated insulin required that is given as SMB.', color: 'zt' },
  { term: 'Smoothing', definition: 'Indicates glucose smoothing is enabled.', color: 'gray' },
];
