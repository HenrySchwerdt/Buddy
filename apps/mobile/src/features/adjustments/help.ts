/** Help sheet copy, verbatim from Trio's OverrideHelpView / TempTargetHelpView. */

export const OVERRIDE_HELP = [
  {
    paragraphs: [
      ['This feature can be used to override these therapy settings for a chosen length of time:', '• Basal Rate', '• Insulin Sensitivity', '• Carb Ratio', '• Glucose Target'],
      'There are also options to override your Max SMB Minutes and Max UAM SMB Minutes, as well as to disable SMBs.',
      'Select "Start Override" to immediately start using the Override, or select "Save as Preset" to be able to easily start the Override at a later time.',
      'If an active override preset is edited, the changes will also apply to the currently running override. However, if you edit the currently running override directly, the preset stays unchanged.',
      'If using Dynamic ISF (without Sigmoid), overriding your ISF will only adjust the limits of the ISF the algorithm is allowed to set.',
      'If using Dynamic ISF (with Sigmoid), overriding your ISF will adjust the ISF used at your glucose target which extends to the ISF used at other glucose. Overriding your glucose target will change glucose level your ISF will be set to your profile ISF. Both of these can be combined in a single Override.',
    ],
  },
] as const;

export const TEMP_TARGET_HELP = [
  {
    header: 'Overview',
    paragraphs: [
      'A Temporary Target replaces the current Target Glucose specified in Therapy settings.',
      'Depending on your Target Behavior settings (see Settings > the Algorithm > Target Behavior), these temporary glucose targets can also raise Insulin Sensitivity for high targets or lower sensitivity for low targets.',
      'Furthermore, you could adjust that sensitivity change independently from the Half Basal Exercise Target specified in Algorithm > Target Behavior settings by deliberately setting a customized Insulin Percentage for a Temp Target.',
      'A pre-condition to have Temp Targets adjust Sensitivity is that the respective Target Behavior settings High Temp Target Raises Sensitivity or Low Temp Target Lowers Sensitivity are set to enabled.',
    ],
  },
  {
    header: 'Sensitivity Limits',
    paragraphs: [
      'Sensitivity changes from Temp Targets have a built-in minimum of 15%. Even very high Temp Targets cannot reduce insulin delivery below 15% of normal.',
      'This 15% minimum is a safety limit taken from oref (OpenAPS reference design) and AndroidAPS. It helps prevent insulin delivery from dropping to unsafe levels.',
      'Important: Autosens Min and Autosens Max do not affect Temp Targets in the same way. Autosens Max limits how much insulin can be increased, but Autosens Min does not remove the 15% minimum when insulin is reduced.',
      'This difference exists because situations like exercise often need a much larger insulin reduction than Autosens would detect during a normal daily routine.',
    ],
  },
] as const;
