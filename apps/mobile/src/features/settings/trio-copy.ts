// Trio dev setting copy (label, mini hint, verbose hint), extracted verbatim from the
// SettingInputSection calls in Trio/Sources/Modules/<Module>/View/<Module>RootView.swift.
// Tokens: {g:N} = N mg/dL formatted in the user's unit, {unit} = unit name.
// Hint line prefixes: "**" bold, "!!" bold orange warning.
import type { TrioSettingCopy } from './types';

export const TRIO_COPY = {
  "maxIOB": {
    "label": "Maximum Insulin on Board (IOB)",
    "miniHint": "Maximum units of insulin allowed to be active.",
    "hint": [
      "**Default: 0 units",
      "!!Note: This setting must be greater than 0 for any automatic insulin dosing by Trio (unless you currently have negative IOB).",
      "Choose a value that covers your highest insulin needs — think about a correction for a very high glucose reading plus your biggest meal bolus. This gives Trio room to work while keeping you safe.",
      "Max IOB sets a safety limit on how much insulin Trio can automatically deliver above your scheduled basal rates. This prevents the system from giving too much insulin at once.",
      "Trio calculates your current Insulin On Board (IOB) from:",
      "• Boluses (including SMBs)",
      "• Temporary Basal Rates (TBRs)",
      "  ◦ A TBR higher than your scheduled rate will increase IOB",
      "  ◦ A TBR lower than your scheduled rate will decrease IOB",
      "If delivering more insulin would push your IOB above this limit, Trio will reduce or skip the dose to stay within the safety boundary. This applies to SMBs, TBRs, and the recommendation from the bolus calculator.",
      "What's NOT limited:",
      "• Manual boluses you enter yourself",
      "• Manual temporary basal rates you set yourself"
    ]
  },
  "maxBolus": {
    "label": "Maximum Bolus",
    "miniHint": "Largest bolus of insulin allowed.",
    "hint": [
      "**Default: 10 units",
      "This is the maximum bolus allowed to be delivered at one time. This only limits manual boluses and does not limit SMBs.",
      "Most set this to their largest meal bolus. Then, adjust if needed.",
      "If you attempt to request a bolus larger than this, the bolus will not be accepted."
    ]
  },
  "maxBasal": {
    "label": "Maximum Basal Rate",
    "miniHint": "Largest basal rate allowed.",
    "hint": [
      "**Default: 2 U/hr",
      "This is the maximum basal rate allowed to be set or scheduled. This applies to both automatic and manual basal rates."
    ]
  },
  "maxCOB": {
    "label": "Maximum Carbs on Board (COB)",
    "miniHint": "Maximum amount of active carbs considered by the algorithm.",
    "hint": [
      "**Default: 120 grams of carbs",
      "This setting defines the maximum amount of Carbs On Board (COB) at any given time for Trio to use in dosing calculations. If more carbs are entered than allowed by this limit, Trio will cap the current COB in calculations to Max COB and remain at max until all remaining carbs have shown to be absorbed.",
      "For example, if Max COB is 120 g and you enter a meal containing 150 g of carbs, your COB will remain at 120 g until the remaining 30 g have been absorbed.",
      "This is an important limit when UAM is ON."
    ]
  },
  "threshold_setting": {
    "label": "Minimum Safety Threshold",
    "miniHint": "Increase the safety threshold used to suspend insulin delivery.",
    "hint": [
      "**Default: Set by Algorithm",
      "Minimum Threshold Setting is, by default, determined by your set Glucose Target. This threshold automatically suspends insulin delivery if your glucose levels are forecasted to fall below this value. It’s designed to protect against hypoglycemia, particularly during sleep or other vulnerable times.",
      "Trio will use the larger of the default setting calculation below and the value entered here.",
      "**The default setting is based on this calculation:",
      "TargetGlucose - 0.5 × (TargetGlucose - 40)",
      "If your glucose target is {g:110} {unit}, Trio will use a safety threshold of {g:75} {unit}, unless you set Minimum Safety Threshold to something > {g:75} {unit}.",
      "{g:110} - 0.5 × ({g:110} - {g:40}) = {g:75}",
      "This setting is limited to values between {g:60} - {g:120} {unit}",
      "Note: Basal may be resumed if there is negative IOB and glucose is rising faster than the forecast."
    ]
  },
  "autosensMax": {
    "label": "Autosens Max",
    "miniHint": "Upper limit of the Sensitivity Ratio.",
    "hint": [
      "**Default: 120%",
      "Autosens Max sets the maximum Sensitivity Ratio used by Autosens, Dynamic ISF, and Sigmoid Formula.",
      "The Sensitivity Ratio is used to calculate the amount of adjustment needed to basal rates and ISF.",
      "Tip: Increasing this value allows automatic adjustments of basal rates to be higher and ISF to be lower."
    ],
    "header": "Glucose Deviations Algorithm"
  },
  "autosensMin": {
    "label": "Autosens Min",
    "miniHint": "Lower limit of the Sensitivity Ratio.",
    "hint": [
      "**Default: 70%",
      "Autosens Min sets the minimum Sensitivity Ratio used by Autosens, Dynamic ISF, and Sigmoid Formula.",
      "The Sensitivity Ratio is used to calculate the amount of adjustment needed to basal rates and ISF.",
      "Tip: Decreasing this value allows automatic adjustments of basal rates to be lower and ISF to be higher."
    ]
  },
  "rewindResetsAutosens": {
    "label": "Rewind Resets Autosens",
    "miniHint": "Pump rewind initiates a reset in Sensitivity Ratio.",
    "hint": [
      "**Default: ON",
      "**Medtronic and Dana Users Only",
      "This feature resets the Sensitivity Ratio to neutral when you rewind your pump on the assumption that this corresponds to a site change.",
      "Autosens will begin learning sensitivity anew from the time of the rewind, which may take up to 6 hours.",
      "Tip: If you usually rewind your pump independently of site changes, you may want to consider disabling this feature."
    ]
  },
  "enableSMBAlways": {
    "label": "Enable SMB Always",
    "miniHint": "Allow SMBs at all times except when a high Temp Target is set.",
    "hint": [
      "**Default: OFF",
      "When enabled, Super Micro Boluses (SMBs) will always be allowed if dosing calculations determine insulin is needed via the SMB delivery method, except when a high Temp Target is set. Enabling SMB Always will remove redundant \"Enable SMB\" options when this setting is enacted.",
      "Note: If you would like to allow SMBs when a high Temp Target is set, enable the \"Allow SMBs with High Temptarget\" setting."
    ],
    "header": "Super-Micro-Bolus"
  },
  "enableSMBWithCOB": {
    "label": "Enable SMB With COB",
    "miniHint": "Allow SMB when carbs are on board.",
    "hint": [
      "**Default: OFF",
      "When there are carbs on board (COB > 0), enabling this feature allows Trio to use Super Micro Boluses (SMB) to deliver the insulin required.",
      "Note: If this is enabled and the criteria are met, SMBs could be utilized regardless of other SMB settings being enabled or not."
    ]
  },
  "enableSMBWithTemptarget": {
    "label": "Enable SMB With Temptarget",
    "miniHint": "Allow SMB when a manual Temporary Target is set under {g:100} {unit}.",
    "hint": [
      "**Default: OFF",
      "Enabling this feature allows Trio to deliver insulin required using Super Micro Boluses (SMB) at times when a manual Temporary Target under {g:100} {unit} is set.",
      "Note: If this is enabled and the criteria are met, SMBs could be utilized regardless of other SMB settings being enabled or not."
    ]
  },
  "enableSMBAfterCarbs": {
    "label": "Enable SMB After Carbs",
    "miniHint": "Allow SMB for 6 hrs after a carb entry.",
    "hint": [
      "**Default: OFF",
      "Enabling this feature allows Trio to deliver insulin required using Super Micro Boluses (SMB) for 6 hours after a carb entry, regardless of whether there are active carbs on board (COB).",
      "Note: If this is enabled and the criteria are met, SMBs could be utilized regardless of other SMB settings being enabled or not."
    ]
  },
  "enableSMB_high_bg": {
    "label": "Enable SMB With High Glucose",
    "miniHint": "Allow SMB when glucose is above the High Glucose Target value.",
    "hint": [
      "**Default: OFF",
      "Enabling this feature allows Trio to deliver insulin required using Super Micro Boluses (SMB) when glucose reading is above the value set as High Glucose Target.",
      "Note: If this is enabled and the criteria are met, SMBs could be utilized regardless of other SMB settings being enabled or not."
    ],
    "conditionalLabel": "High Glucose Target"
  },
  "allowSMBWithHighTemptarget": {
    "label": "Allow SMB With High Temptarget",
    "miniHint": "Allow SMB when a manual Temporary Target is set greater than {g:100} {unit}.",
    "hint": [
      "**Default: OFF",
      "Enabling this feature allows Trio to deliver insulin required using Super Micro Boluses (SMB) when a manual Temporary Target above {g:100} {unit} is set.",
      "Note: If this is enabled and the criteria are met, SMBs could be utilized regardless of other SMB settings being enabled or not.",
      "**Warning: High Temp Targets are often set when recovering from lows. If you use High Temp Targets for that purpose, this feature should remain disabled."
    ]
  },
  "enableUAM": {
    "label": "Enable UAM",
    "miniHint": "Enable Unannounced Meals SMB.",
    "hint": [
      "**Default: OFF",
      "Enabling the UAM (Unannounced Meals) feature allows the system to detect and respond to unexpected rises in glucose readings caused by unannounced or miscalculated carbs, meals high in fat or protein, or other factors like adrenaline.",
      "It uses the SMB (Super Micro Bolus) algorithm to deliver insulin in small amounts to correct glucose spikes. UAM also works in reverse, reducing or stopping SMBs if glucose levels drop unexpectedly.",
      "This feature ensures more accurate insulin adjustments when carb entries are missing or incorrect."
    ]
  },
  "maxSMBBasalMinutes": {
    "label": "Max SMB Basal Minutes",
    "miniHint": "Limits the size of a single Super Micro Bolus (SMB) dose.",
    "hint": [
      "**Default: 30 minutes",
      "**(50% current basal rate)",
      "This is a limit on the size of a single SMB. One SMB can only be as large as this many minutes of your current profile basal rate.",
      "To calculate the maximum SMB allowed based on this setting, use the following formula:",
      "𝒳 = Max SMB Basal Minutes",
      "(𝒳 / 60) × current basal rate",
      "**Warning: Increasing this value above 90 minutes may impact Trio's ability to effectively zero temp and prevent lows.",
      "Note: SMBs must be enabled to use this limit."
    ]
  },
  "maxUAMSMBBasalMinutes": {
    "label": "Max UAM Basal Minutes",
    "miniHint": "Limits the size of a single Unannounced Meal (UAM) SMB dose.",
    "hint": [
      "**Default: 30 minutes",
      "**(50% current basal rate)",
      "This is a limit on the size of a single UAM SMB. One UAM SMB can only be as large as this many minutes of your current profile basal rate.",
      "To calculate the maximum UAM SMB allowed based on this setting, use the following formula:",
      "𝒳 = Max UAM SMB Basal Minutes",
      "(𝒳 / 60) × current basal rate",
      "**Warning: Increasing this value above 90 minutes may impact Trio's ability to effectively zero temp and prevent lows.",
      "Note: UAM SMBs must be enabled to use this limit."
    ]
  },
  "maxDeltaBGthreshold": {
    "label": "Max Allowed Glucose Rise for SMB",
    "miniHint": "Disables SMBs if last two glucose values differ by more than this percent.",
    "hint": [
      "**Default: 20% increase",
      "Maximum allowed positive percent change in glucose level to permit SMBs. If the difference in glucose is greater than this, Trio will only adjust Temp Basal Rate and not deliver an SMB that loop cycle.",
      "This is a safety limitation to avoid high SMB doses when glucose is rising abnormally fast, such as after a meal or with a very jumpy CGM sensor.",
      "Note: This setting has a hard-coded cap of 40%"
    ]
  },
  "adjustmentFactor": {
    "label": "Adjustment Factor (AF)",
    "miniHint": "Alter the rate of Dynamic ISF (Sensitivity) adjustments.",
    "hint": [
      "**Default: 80%",
      "The Adjustment Factor (AF) allows you to control how quickly and effectively Dynamic ISF responds to changes in glucose levels.",
      "Adjusting this value not only can adjust how quickly your sensitivity will respond to changing glucose readings, but also at what glucose readings you reach your Autosens Max/Min limits.",
      "Increasing this setting can make ISF adjustments quicker, but will also change the glucose value that coincides with the ISF used at your Autosens Max and Autosens Min limits. Likewise, decreasing this setting can make ISF adjustments slower and will also change the glucose value that coincides with the ISF used when it reaches the Autosens Max and Autosens Min limits. It is best to utilize the Desmos graphs from TrioDocs.org to optimize all Dynamic Settings."
    ]
  },
  "adjustmentFactorSigmoid": {
    "label": "Sigmoid Adjustment Factor",
    "miniHint": "Alter the rate of dynamic sensitivity adjustments for Sigmoid.",
    "hint": [
      "**Default: 50%",
      "The Sigmoid Adjustment Factor (AF) allows you to control how quickly Sigmoid Dynamic ISF responds to changes in glucose levels and at what glucose value you will reach your Autosens Max and Autosens Min limits.",
      "Sigmoid Adjustment Factor influences both how fast your ISF values will change and how quickly you will reach your Autosens Max and Min limits set. Increasing Sigmoid Adjustment Factor increases the rate of change of your ISF and reduces the range of glucose values between your Autosens Max and Min limits.",
      "This setting allows for a more responsive system, but the effects are restricted by the Autosens Min/Max settings.",
      "Due to how the curve is calculated when using the Sigmoid Formula, increasing this setting has a different impact on the steepness of the curve than in the standard logarithmic Dynamic ISF calculation. Use caution when adjusting this setting."
    ]
  },
  "weightPercentage": {
    "label": "Weighted Average of TDD",
    "miniHint": "Weight of 24-hr TDD against 10-day TDD.",
    "hint": [
      "**Default: 35%",
      "This setting adjusts how much weight is given to your recent total daily insulin dose when calculating Dynamic ISF and Dynamic CR.",
      "At the default setting, 35% of the calculation is based on the last 24 hours of insulin use, with the remaining 65% considering the last 10 days of data.",
      "Setting this to 100% means only the past 24 hours will be used.",
      "A lower value smooths out these variations for more stability."
    ]
  },
  "tddAdjBasal": {
    "label": "Adjust Basal",
    "miniHint": "Use Dynamic Ratio to adjust basal rates.",
    "hint": [
      "**Default: OFF",
      "Turn this setting on to give basal adjustments more agility. Keep this setting off if your basal needs are not highly variable.",
      "Enabling Adjust Basal replaces the standard Autosens Ratio calculation with its own Autosens Ratio calculated as such:",
      "Autosens Ratio =\n(Weighted Average of TDD) / (10-day Average of TDD)",
      "New Basal Profile =\n(Current Basal Profile) × (Autosens Ratio)"
    ],
    "header": "Dynamic-dependent Features"
  },
  "highTemptargetRaisesSensitivity": {
    "label": "High Temp Target Raises Sensitivity",
    "miniHint": "Increase sensitivity when glucose is above target if a manual Temp Target > {g:100} {unit} is set.",
    "hint": [
      "**Default: OFF",
      "When this feature is enabled, manually setting a temporary target above {g:100} {unit} will decrease the Autosens Ratio used for ISF and basal adjustments, resulting in less insulin delivered overall. This scales with the temporary target set; the higher the temp target, the lower the Autosens Ratio used.",
      "If Half Basal Exercise Target is set to {g:160} {unit}, a temp target of {g:120} {unit} uses an Autosens Ratio of 0.75. A temp target of {g:140} {unit} uses an Autosens Ratio of 0.6.",
      "Note: The effect of this can be adjusted with the Half Basal Exercise Target"
    ],
    "header": "Algorithmic Target Settings"
  },
  "lowTemptargetLowersSensitivity": {
    "label": "Low Temp Target Lowers Sensitivity",
    "miniHint": "Decrease sensitivity when glucose is below target if a manual Temp Target < {g:100} {unit} is set.",
    "hint": [
      "**Default: OFF",
      "When this feature is enabled, setting a temporary target below {g:100} {unit} will increase the Autosens Ratio used for ISF and basal adjustments, resulting in more insulin delivered overall. This scales with the temporary target set; the lower the Temp Target, the higher the Autosens Ratio used. It requires Algorithm Settings > Autosens > Autosens Max to be set to > 100% to work.",
      "If Half Basal Exercise Target is {g:160} {unit}, a Temp Target of {g:95} {unit} uses an Autosens Ratio of 1.09. A Temp Target of {g:85} {unit} uses an Autosens Ratio of 1.33.",
      "Note: The effect of this can be adjusted with the Half Basal Exercise Target"
    ]
  },
  "sensitivityRaisesTarget": {
    "label": "Sensitivity Raises Target",
    "miniHint": "Raise target glucose when Autosens Ratio is less than 1.",
    "hint": [
      "**Default: OFF",
      "Enabling this feature causes Trio to automatically raise the targeted glucose if it detects an increase in insulin sensitivity from your baseline."
    ]
  },
  "resistanceLowersTarget": {
    "label": "Resistance Lowers Target",
    "miniHint": "Lower target glucose when Autosens Ratio is greater than 1.",
    "hint": [
      "**Default: OFF",
      "Enabling this feature causes Trio to automatically reduce the targeted glucose if it detects a decrease in sensitivity (resistance) from your baseline."
    ]
  },
  "halfBasalExerciseTarget": {
    "label": "Half Basal Exercise Target",
    "miniHint": "Scales down your basal rate to 50% at this value.",
    "hint": [
      "**Default: {g:160} {unit}",
      "The Half Basal Exercise Target allows you to scale down your basal insulin during exercise or scale up your basal insulin when eating soon when a temporary glucose target is set.",
      "For example, at a temp target of {g:160} {unit}, your basal is reduced to 50%, but this scales depending on the target (e.g., 75% at {g:120} {unit}, 60% at {g:140} {unit}).",
      "Note: This setting is only utilized if the settings \"Low Temp Target Lowers Sensitivity\" OR \"High Temp Target Raises Sensitivity\" are enabled."
    ]
  },
  "maxDailySafetyMultiplier": {
    "label": "Max Daily Safety Multiplier",
    "miniHint": "Limits temporary basal rates to this percentage of your largest basal rate.",
    "hint": [
      "**Default: 300%",
      "This setting restricts the maximum temporary basal rate Trio can set. At the default of 300%, it caps it at 3 times your highest programmed basal rate.",
      "It serves as a safety limit, ensuring no temporary basal rates exceed safe levels.",
      "**Warning: Increasing this setting is not advised."
    ]
  },
  "currentBasalSafetyMultiplier": {
    "label": "Current Basal Safety Multiplier",
    "miniHint": "Limits temporary basal rates to this percentage of the current basal rate.",
    "hint": [
      "**Default: 400%",
      "This limits the automatic adjustment of the temporary basal rate to this percentage of the current hourly profile basal rate at the time of the loop cycle.",
      "This prevents excessive dosing, especially during times of variable insulin sensitivity, enhancing safety.",
      "**Warning: Increasing this setting is not advised."
    ]
  },
  "insulinActionCurve": {
    "label": "Duration of Insulin Action",
    "miniHint": "Number of hours insulin is active in your body.",
    "hint": [
      "**Default: 10 hours",
      "The Duration of Insulin Action (DIA) defines how long your insulin continues to lower glucose readings after a dose.",
      "This helps the system accurately track Insulin on Board (IOB), avoiding over- or under-corrections by considering the tail end of insulin's effect.",
      "Tip: It is better to use Custom Peak Time rather than adjust your Duration of Insulin Action (DIA)."
    ]
  },
  "useCustomPeakTime": {
    "label": "Use Custom Peak Time",
    "miniHint": "Set a custom time for peak insulin effect.",
    "hint": [
      "**Default: Set by Insulin Type",
      "Insulin Peak Time defines when insulin is most effective in lowering glucose, set in minutes after dosing.",
      "This peak informs the system when to expect the most potent glucose-lowering effect, helping it predict glucose trends more accurately.",
      "**System-Determined Defaults:",
      "Ultra-Rapid: 55 minutes (permitted range 35-100 minutes)",
      "Rapid-Acting: 75 minutes (permitted range 50-120 minutes)"
    ],
    "conditionalLabel": "Insulin Peak Time"
  },
  "skipNeutralTemps": {
    "label": "Skip Neutral Temps",
    "miniHint": "Skip neutral temporary basal rates to reduce MDT pump alerts.",
    "hint": [
      "**Default: OFF",
      "When Skip Neutral Temps is enabled, Trio will not set neutral basal rates shortly before the hour, minimizing hourly pump alerts on MDT pumps. This can help light sleepers avoid alerts but will delay basal adjustments. This will also only come into effect if SMB's are disabled for whatever reason.",
      "For most users, leaving this OFF is recommended to ensure consistent basal delivery and loop calculation. If this option is effective, loops will be skipped during the last 5 minutes of the hour."
    ]
  },
  "unsuspendIfNoTemp": {
    "label": "Unsuspend If No Temp",
    "miniHint": "Resume pump automatically after suspension.",
    "hint": [
      "**Default: OFF",
      "Enabling Unsuspend If No Temp allows Trio to resume your pump if you forget, as long as a zero temp basal was set first. This feature ensures insulin delivery restarts if you forget to manually unsuspend, adding a safeguard for pump reconnections.",
      "Note: Applies only to pumps with on-pump suspend options"
    ]
  },
  "smbDeliveryRatio": {
    "label": "SMB Delivery Ratio",
    "miniHint": "Percentage of calculated insulin required that is given as SMB.",
    "hint": [
      "**Default: 50%",
      "Once the total insulin required is calculated, this safety limit specifies what percentage of the insulin required can be delivered as an SMB.",
      "Due to SMBs potentially occurring every 5 minutes with each loop cycle, it is important to set this value to a reasonable level that allows Trio to safely zero temp should dosing needs suddenly change. Increase this value with caution.",
      "Note: Allowed range is 30 - 70%"
    ]
  },
  "smbInterval": {
    "label": "SMB Interval",
    "miniHint": "Minimum minutes since the last SMB or manual bolus to allow an automated SMB.",
    "hint": [
      "**Default: 3 min",
      "This is the minimum number of minutes since the last SMB or manual bolus before Trio will permit an automated SMB."
    ]
  },
  "min5mCarbimpact": {
    "label": "Min 5m Carb Impact",
    "miniHint": "Default impact of carb absorption over a 5 minute interval.",
    "hint": [
      "Min 5m Carb Impact sets the expected glucose rise from carbs over 5 minutes when absorption isn't obvious from glucose data.",
      "The default is an expected {g:8} {unit}/5min. This affects how fast COB is decayed in situations when carb absorption is not visible in BG deviations. The default of {g:8} {unit}/5min corresponds to a minimum carb absorption rate of 24 g/hr at a CSF of {g:4} {unit}/g.",
      "This setting helps the system estimate how much glucose your body is absorbing, even when it's not immediately visible in your glucose data, ensuring more accurate insulin dosing during carb absorption."
    ]
  },
  "remainingCarbsFraction": {
    "label": "Remaining Carbs Percentage",
    "miniHint": "Percentage of carbs still available if no absorption is detected.",
    "hint": [
      "**Default: 100%",
      "Remaining Carbs Percentage estimates carbs still absorbing over 4 hours if glucose data doesn't show clear absorption.",
      "This fallback setting prevents under-dosing by spreading a portion of the entered carbs over time, balancing insulin needs with undetected carb impact."
    ]
  },
  "remainingCarbsCap": {
    "label": "Remaining Carbs Cap",
    "miniHint": "Maximum amount of carbs still available if no absorption is detected.",
    "hint": [
      "**Default: 90 g",
      "The Remaining Carbs Cap defines the upper limit for how many carbs the system will assume are absorbing over 4 hours, even when there's no clear sign of absorption from your glucose readings.",
      "This cap prevents the system from overestimating how much insulin is needed when carb absorption isn't visible, offering a safeguard for accurate dosing."
    ]
  },
  "noisyCGMTargetMultiplier": {
    "label": "Noisy CGM Target Increase",
    "miniHint": "Percentage increase of glucose target when CGM is inconsistent.",
    "hint": [
      "**Default: 130%",
      "The Noisy CGM Target Increase raises your glucose target when the system detects noisy or raw CGM data. By default, the target is increased to 130% of your set target glucose to account for the less reliable glucose readings.",
      "This helps reduce the risk of incorrect insulin dosing based on inaccurate sensor data, ensuring safer insulin adjustments during periods of poor CGM accuracy.",
      "Note: A CGM is considered noisy when it provides inconsistent readings."
    ]
  },
  "displayPresets": {
    "label": "Display Meal Presets",
    "miniHint": "Allow the creation of saved, preset meals.",
    "hint": [
      "**Default: ON",
      "Enabling this feature allows you to create and save preset meals."
    ]
  },
  "overrideFactor": {
    "label": "Recommended Bolus Percentage",
    "miniHint": "Percentage of bolus suggested in bolus calculator.",
    "hint": [
      "**Default: 80%",
      "Recommended Bolus Percentage is a safety feature built into Trio. Trio first calculates an insulin required value, which is the full dosage. That dosage is then multiplied by your Recommended Bolus Percentage to display your suggested insulin dose in the bolus calculator.",
      "Because Trio utilizes SMBs and UAM SMBs to help you reach your target glucose and other AID systems do not bolus for COB the same way Trio does, this is initially set to below the full calculated amount (80%). When SMBs and UAM SMBs are enabled, you may find your current CR results in lows and needs to be increased before you increase this setting closer to or at 100%.",
      "Tip: If you are a new Trio user, it is not advised to set this to 100% until you have verified that your core settings (basal rates, ISF, and CR) do not need adjusting."
    ],
    "header": "Calculator Configuration"
  },
  "fattyMeals": {
    "label": "Enable Reduced Bolus Option",
    "miniHint": "Add and set a bolus option for meals that absorb slowly.",
    "hint": [
      "**Default: OFF",
      "**Default Percent: 70%",
      "**Do not enable this feature until you have optimized your CR (carb ratio) setting.",
      "Enabling this setting adds a \"Reduced Bolus\" option to the bolus calculator. Once this feature is enabled, a percentage setting will appear for you to select.",
      "When \"Reduced Bolus\" is selected in the bolus calculator, the recommended bolus will be multiplied by the \"Reduced Bolus Percentage\" as well as the \"Recommended Bolus Percentage\".",
      "If you have a \"Recommended Bolus Percentage\" of 80%, and a \"Reduced Bolus Percentage\" of 70%, your recommended bolus will be multiplied by: (80 × 70) / 100 = 56%.",
      "This is useful for slow-absorbing meals where high fat, protein, or fiber can delay carb absorption and cause a slower rise in blood sugar, so a reduced bolus helps match insulin to the delayed effect."
    ],
    "conditionalLabel": "Reduced Bolus Percentage"
  },
  "sweetMeals": {
    "label": "Enable Super Bolus Option",
    "miniHint": "Add and set a bolus option for meals that absorb quickly.",
    "hint": [
      "**Default: OFF",
      "**Default Percent: 100%",
      "**Do not enable this feature until you have optimized your CR (carb ratio) setting.",
      "Enabling this setting adds a \"Super Bolus\" option to the bolus calculator. Once this feature is enabled, a percentage setting will appear for you to select.",
      "When \"Super Bolus\" is selected in the bolus calculator, your current basal rate multiplied by \"Super Bolus Percentage\" will be added to your bolus recommendation.",
      "If your current basal rate is 0.8 U/hr and \"Super Bolus Percentage\" is set to 200%: 0.8 × (200 / 100) = 1.6 units will be added to your bolus recommendation.",
      "This could be useful for fast absorbing meals like sugary cereal."
    ],
    "conditionalLabel": "Super Bolus Percentage"
  },
  "confirmBolusWhenVeryLowGlucose": {
    "label": "Very Low Glucose Warning",
    "miniHint": "Warning when bolusing with a very low or forecasted very low glucose.",
    "hint": [
      "**Default: OFF",
      "Triggers a confirmation dialog if you attempt to bolus when glucose is < {g:54} {unit}.",
      "Also triggered when the lowest forecasted glucose (minPredBG) is < {g:54} {unit}.",
      "Note: The forecast used for this warning does not include carbs or insulin that have been logged but not yet effective."
    ]
  },
  "maxMealAbsorptionTime": {
    "label": "Max Meal Absorption Time",
    "miniHint": "The maximum duration for tracking carb entries in estimating Carbs on Board (COB)",
    "hint": [
      "**Default: 6 hours",
      "Carb entries will be fully decayed by the number of hours specified as Max Meal Absorption Time. Meals that are high in fat and/or protein can have long lasting effects on glucose levels. To allow such late meal effects to be considered by the carb decay model, a longer Max Meal Absorption Time than the default 6 hours can be set.",
      "If carb entries decay too slowly, it is possible to set a lower than default setting. But this should typically be addressed by tuning ISF and CR settings instead, which in combination determines the rate of carb decay.",
      "Min 4 hours, max 10 hours."
    ]
  },
  "useFPUconversion": {
    "label": "Enable Fat and Protein Entries",
    "miniHint": "Add fat and protein macros to meal entries.",
    "hint": [
      "**Default: OFF",
      "Enabling this setting allows you to log fat and protein, which are then converted into future carb equivalents using the Warsaw Method.",
      "**Warsaw Method:",
      "The Warsaw Method helps account for the delayed glucose spikes caused by fat and protein in meals. It uses Fat-Protein Units (FPU) to calculate the carb effect from fat and protein. The system spreads insulin delivery over several hours to mimic natural insulin release, helping to manage post-meal glucose spikes.",
      "**Fat Conversion",
      "𝑭 = fat(g) × 90%",
      "**Protein Conversion",
      "𝑷 = protein(g) × 40%",
      "**FPU Conversion",
      "𝑭 + 𝑷 = g CHO",
      "You can personalize the conversion calculation by adjusting the following settings that will appear when this option is enabled:",
      "• Fat and Protein Delay",
      "• Spread Interval",
      "• Fat and Protein Percentage"
    ],
    "header": "Fat and Protein"
  },
  "delay": {
    "label": "Fat and Protein Delay",
    "miniHint": "Delay between fat & protein entry and first FPU entry.",
    "hint": [
      "**Default: 60 min",
      "The Fat and Protein Delay setting defines the time between when you log fat and protein and when the system starts delivering insulin for the Fat-Protein Unit Carb Equivalents (FPUs).",
      "This delay accounts for the slower absorption of fat and protein, as calculated by the Warsaw Method, ensuring insulin delivery is properly timed to manage glucose spikes caused by high-fat, high-protein meals."
    ]
  },
  "minuteInterval": {
    "label": "Spread Interval",
    "miniHint": "Time interval between FPUs.",
    "hint": [
      "**Default: 30 minutes",
      "This determines how many minutes will be between individual Fat-Protein Unit Carb Equivalent (FPU) entries from a single Fat and/or Protein bolus calculator entry.",
      "Entries are capped at 33 grams each, with up to three entries, for a max total of 99 grams."
    ]
  },
  "individualAdjustmentFactor": {
    "label": "Fat and Protein Percentage",
    "miniHint": "Adjust the Warsaw Method FPU Conversion rate.",
    "hint": [
      "**Default: 50%",
      "This setting changes how much effect the fat and protein entry has on FPUs.",
      "**50% is half effect:",
      "(Fat × 45%) + (Protein × 20%)",
      "**100% is full effect:",
      "(Fat × 90%) + (Protein × 40%)",
      "**110% makes fat-to-carbs ratio essentially equal:",
      "(Fat × 99%) + (Protein x 44%)",
      "Tip: You may find that your normal carb ratio needs to increase to a larger number when you begin adding fat and protein entries. For this reason, it is best to start with a factor of about 50%."
    ]
  },
  "rulerMarks": {
    "label": "Show Low and High Thresholds",
    "miniHint": "Display the Low and High glucose thresholds set below.",
    "hint": [
      "This setting displays the upper and lower values for your glucose target range.",
      "This range is for display and statistical purposes only and does not influence insulin dosing."
    ]
  },
  "showCarbsRequiredBadge": {
    "label": "Show Carbs Required Badge",
    "miniHint": "Show carbs required as a red icon on the main graph icon.",
    "hint": [
      "Turning this on will show the grams of carbs needed to prevent a low as a notification badge on the Trio home screen located above the main icon.\n\nOnce enabled, set the Carbs Required Threshold to the lowest number of carbs you'd like to be recommended. A recommendation will not be given if carbs required is below this number.\n\nNote: The carbs suggested with this feature are to be used as a recommendation, not as a requirement. Depending on the current accuracy of your sensor and the accuracy of your settings, the suggested carbs can vary widely. Use your best judgement before ingesting the suggested quantity of carbs."
    ],
    "header": "Carbs Required Badge",
    "conditionalLabel": "Carbs Required Threshold"
  },
  "requireAdjustmentsConfirmation": {
    "label": "Require Adjustments Confirmation",
    "miniHint": "If enabled, a confirmation dialog will be shown when activating adjustment presets.",
    "hint": [
      "Turning this on will show a confirmation dialog when you activate an Override or Temporary Target preset. This is for users who would like avoid accidentally activating a preset by mistake."
    ],
    "header": "Adjustments"
  },
  "allowBolusByShortcuts": {
    "label": "Allow Bolusing with Shortcuts",
    "miniHint": "Automate boluses using the iOS Shortcuts App.",
    "hint": [
      "**Default: OFF",
      "Enabling this setting allows the iOS Shortcuts App to send bolus commands to Trio.",
      "Disabling this setting will still allow other commands, like Temp Targets, Add Carbs, and Start/End Overrides"
    ]
  },
  "isTrioRemoteControlEnabled": {
    "label": "Enable Remote Control",
    "miniHint": "Allow Trio to receive commands from Loop Follow remotely.",
    "hint": [
      "**Default: OFF",
      "When Remote Control is enabled, you can send boluses, overrides, temporary targets, carbs, and other commands to Trio via push notifications.",
      "To ensure security, these commands are protected by a shared secret, which must be entered in the Loop Follow app."
    ],
    "header": "Trio Remote Control"
  },
  "enableQuickPickTreatments": {
    "label": "Enable Quick-Pick Treatments",
    "miniHint": "Long-press the + button on the home screen to enact a quick-pick treatment.",
    "hint": [
      "**Default: OFF",
      "When enabled, long-pressing the + button on the home screen opens a Quick-Pick Treatments sheet. It suggests up to three bolus amounts and, if you have carb history, up to three carb amounts based on what you typically enter at this time of day, weighted by recency and day type (weekday vs. weekend).",
      "Tap a bolus amount, a carb amount, or both, then slide to confirm. Face ID or Touch ID is always required before a bolus is enacted."
    ]
  }
} as const satisfies Record<string, TrioSettingCopy>;

export type TrioCopyKey = keyof typeof TRIO_COPY;
