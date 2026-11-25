import { brand } from './copy';

/** Port of Trio's `SettingItem` (Modules/Settings/SettingItems.swift) with Buddy routes. */
export interface SettingItem {
  readonly title: string;
  readonly route: string;
  readonly searchContents?: readonly string[];
  readonly path?: readonly string[];
}

export interface FilteredSettingItem {
  readonly item: SettingItem;
  readonly matchedContent: string;
}

const R = {
  devices: '/settings/devices',
  therapy: '/settings/therapy',
  algorithm: '/settings/algorithm',
  features: '/settings/features',
  notifications: '/settings/notifications',
  services: '/settings/services',
  unitsLimits: '/settings/units-limits',
  basal: '/settings/therapy-basal',
  isf: '/settings/therapy-isf',
  cr: '/settings/therapy-carb-ratios',
  targets: '/settings/therapy-targets',
  profiles: '/settings/therapy-profiles',
  autosens: '/settings/algorithm-autosens',
  smb: '/settings/algorithm-smb',
  dynamic: '/settings/algorithm-dynamic',
  targetBehavior: '/settings/algorithm-target-behavior',
  additionals: '/settings/algorithm-additionals',
  bolusCalculator: '/settings/features-bolus-calculator',
  quickPick: '/settings/features-quick-pick',
  meal: '/settings/features-meal',
  shortcuts: '/settings/features-shortcuts',
  remote: '/settings/features-remote-control',
  ui: '/settings/features-user-interface',
  icons: '/settings/features-app-icons',
  diagnostics: '/settings/features-app-diagnostics',
} as const;

export const TRIO_CONFIG_ITEMS: readonly SettingItem[] = [
  { title: 'Devices', route: R.devices },
  { title: 'Therapy', route: R.therapy },
  { title: 'Algorithm', route: R.algorithm },
  { title: 'Features', route: R.features },
  { title: 'Notifications', route: R.notifications },
  { title: 'Services', route: R.services },
];

const DEVICE_ITEMS: readonly SettingItem[] = [
  { title: 'Insulin Pump', route: R.devices, path: ['Devices'] },
  { title: 'CGM', route: R.devices, searchContents: ['Smooth Glucose Value'], path: ['Devices', 'Continuous Glucose Monitor'] },
];

const THERAPY_ITEMS: readonly SettingItem[] = [
  {
    title: 'Units and Limits',
    route: R.unitsLimits,
    searchContents: ['Glucose Units', 'Max Basal', 'Max Bolus', 'Max IOB', 'Max COB', 'Minimum Safety Threshold', 'Delivery Limits', 'Safety Guard', 'Suspend Threshold', 'Max Automatic Bolus'],
    path: ['Therapy Settings', 'Units and Limits'],
  },
  { title: 'Basal Rates', route: R.basal, path: ['Therapy Settings'] },
  { title: 'Insulin Sensitivities', route: R.isf, path: ['Therapy Settings'] },
  { title: 'ISF', route: R.isf, path: ['Therapy Settings'] },
  { title: 'Carb Ratios', route: R.cr, path: ['Therapy Settings'] },
  { title: 'CR', route: R.cr, path: ['Therapy Settings'] },
  { title: 'Glucose Targets', route: R.targets, path: ['Therapy Settings'] },
  { title: 'Therapy Profiles', route: R.profiles, searchContents: ['Profiles', 'Activate Profile', 'Save Current Settings as New Profile', 'Import from Nightscout'], path: ['Therapy Settings'] },
];

const ALGORITHM_ITEMS: readonly SettingItem[] = [
  { title: 'Algorithm', route: R.algorithm, searchContents: ['oref SMB', 'oref Temp Basal', 'Predictive', 'PID'], path: ['Algorithm'] },
  { title: 'Autosens', route: R.autosens, searchContents: ['Autosens Max', 'Autosens Min', 'Rewind Resets Autosens'], path: ['Algorithm', 'Autosens'] },
  {
    title: 'Super Micro Bolus (SMB)',
    route: R.smb,
    searchContents: [
      'Enable SMB Always',
      'Enable SMB With COB',
      'Enable SMB With Temporary Target',
      'Enable SMB After Carbs',
      'Enable SMB With High Glucose',
      'High Glucose Target',
      'Allow SMB With High Temporary Target',
      'Enable UAM',
      'Max SMB Basal Minutes',
      'Max UAM SMB Basal Minutes',
      'Max Allowed Glucose Rise for SMB',
    ],
    path: ['Algorithm', 'Super Micro Bolus (SMB)'],
  },
  {
    title: 'Dynamic Settings',
    route: R.dynamic,
    searchContents: ['Dynamic ISF', 'Sigmoid', 'Logarithmic', 'Adjustment Factor (AF)', 'Sigmoid Adjustment Factor', 'Weighted Average of TDD', 'Adjust Basal'],
    path: ['Algorithm', 'Dynamic Sensitivity'],
  },
  {
    title: 'Target Behavior',
    route: R.targetBehavior,
    searchContents: ['High Temptarget Raises Sensitivity', 'Low Temptarget Lowers Sensitivity', 'Sensitivity Raises Target', 'Resistance Lowers Target', 'Half Basal Exercise Target'],
    path: ['Algorithm', 'Target Behavior'],
  },
  {
    title: 'Additionals',
    route: R.additionals,
    searchContents: [
      'Max Daily Safety Multiplier',
      'Current Basal Safety Multiplier',
      'Use Custom Peak Time',
      'Duration of Insulin Action',
      'DIA',
      'Insulin Peak Time',
      'Skip Neutral Temps',
      'Unsuspend If No Temp',
      'SMB Delivery Ratio',
      'SMB Interval',
      'Min 5m Carbimpact',
      'Remaining Carbs Fraction',
      'Remaining Carbs Cap',
      'Noisy CGM Target Multiplier',
    ],
    path: ['Algorithm', 'Additionals'],
  },
];

const FEATURE_ITEMS: readonly SettingItem[] = [
  {
    title: 'Bolus Calculator',
    route: R.bolusCalculator,
    searchContents: ['Display Meal Presets', 'Recommended Bolus Percentage', 'Enable Reduced Bolus Factor', 'Reduced Bolus Factor', 'Enable Super Bolus', 'Super Bolus Factor', 'Very Low Glucose Warning'],
    path: ['Features', 'Treatments', 'Bolus Calculator'],
  },
  { title: 'Quick-Pick Treatments', route: R.quickPick, searchContents: ['Enable Quick-Pick Treatments'], path: ['Features', 'Treatments', 'Quick-Pick Treatments'] },
  {
    title: 'Meal Settings',
    route: R.meal,
    searchContents: ['Max Carbs', 'Max Meal Absorption Time', 'Max Fat', 'Max Protein', 'Enable Fat and Protein Entries', 'Fat and Protein Delay', 'Spread Interval', 'Fat and Protein Percentage', 'FPU'],
    path: ['Features', 'Treatments', 'Meal Settings'],
  },
  { title: 'Shortcuts', route: R.shortcuts, searchContents: ['Allow Bolusing with Shortcuts'], path: ['Features', 'Shortcuts'] },
  { title: 'Remote Control', route: R.remote, searchContents: ['Remote Control'], path: ['Features', 'Remote Control'] },
  {
    title: 'User Interface',
    route: R.ui,
    searchContents: [
      'Show X-Axis Grid Lines',
      'Show Y-Axis Grid Lines',
      'Show Low and High Thresholds',
      'Low Threshold',
      'High Threshold',
      'eA1c/GMI Display Unit',
      'Show Carbs Required Badge',
      'Carbs Required Threshold',
      'Forecast Display Type',
      'Bolus Display Threshold',
      'Cone',
      'Lines',
      'Appearance',
      'Dark Mode',
      'Light Mode',
      'Glucose Color Scheme',
      'TIR Lower Threshold',
      'Time in Range Type',
      'Home Statistics Range',
      'Require Adjustments Confirmation',
    ],
    path: ['Features', 'User Interface'],
  },
  { title: 'App Icons', route: R.icons, searchContents: ['Trio Icon'], path: ['Features', 'App Icons'] },
  { title: 'App Diagnostics', route: R.diagnostics, searchContents: ['Anonymized Data Sharing'], path: ['Features', 'App Diagnostics'] },
];

const NOTIFICATION_ITEMS: readonly SettingItem[] = [
  { title: 'Glucose Alarms', route: R.notifications, searchContents: ['Urgent Low Glucose', 'Low Glucose', 'Forecasted Low Glucose', 'High Glucose', 'Alert Sound'], path: ['Notifications', 'Glucose Alarms'] },
  { title: 'Device Alarms', route: R.notifications, searchContents: ['Occlusion', 'Reservoir', 'Battery', 'Sensor Failure', 'Signal Loss', 'Not Looping'], path: ['Notifications', 'Device Alarms'] },
];

const SERVICE_ITEMS: readonly SettingItem[] = [
  { title: 'Nightscout', route: R.services, searchContents: ['Import Settings', 'Backfill Glucose'], path: ['Services', 'Nightscout'] },
  { title: 'Nightscout Upload', route: R.services, searchContents: ['Allow Uploading to Nightscout', 'Upload Glucose'], path: ['Services', 'Nightscout', 'Upload'] },
];

export const ALL_ITEMS: readonly SettingItem[] = [...TRIO_CONFIG_ITEMS, ...DEVICE_ITEMS, ...THERAPY_ITEMS, ...ALGORITHM_ITEMS, ...FEATURE_ITEMS, ...NOTIFICATION_ITEMS, ...SERVICE_ITEMS];

/** Port of `SettingItems.filteredItems(searchText:)`: title match first, then each matching search term. */
export function filterSettingItems(searchText: string, items: readonly SettingItem[] = ALL_ITEMS): FilteredSettingItem[] {
  const q = searchText.trim().toLowerCase();
  if (!q) return [];
  const hit = (s: string) => brand(s).toLowerCase().includes(q) || s.toLowerCase().includes(q);
  return items.flatMap((item) => [
    ...(hit(item.title) ? [{ item, matchedContent: item.title }] : []),
    ...(item.searchContents ?? []).filter(hit).map((matchedContent) => ({ item, matchedContent })),
  ]);
}
