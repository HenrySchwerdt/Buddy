import { defineAlgorithm } from '@buddy/core';
import { runOref } from './adapter';
const SMB_SECTION = {
    title: 'Super Micro Bolus',
    fields: [
        { kind: 'boolean', key: 'enableSMBAlways', label: 'Enable SMB always', help: 'Allow SMBs at any time, not only with COB or after carbs.', affectsDosing: true },
        { kind: 'boolean', key: 'enableSMBWithCOB', label: 'Enable SMB with COB', affectsDosing: true },
        { kind: 'boolean', key: 'enableSMBAfterCarbs', label: 'Enable SMB after carbs', help: 'Keep SMBs enabled for 6 h after carbs.', affectsDosing: true },
        { kind: 'boolean', key: 'enableSMBHighBg', label: 'Enable SMB with high glucose', affectsDosing: true },
        { kind: 'number', key: 'enableSMBHighBgTarget', label: 'High glucose SMB threshold', unit: 'mg/dL', min: 120, max: 300, step: 5 },
        { kind: 'boolean', key: 'enableUAM', label: 'Unannounced meals (UAM)', help: 'Detect rises without logged carbs and dose for them.', affectsDosing: true },
        { kind: 'number', key: 'maxSMBBasalMinutes', label: 'Max SMB basal minutes', unit: 'min', min: 15, max: 120, step: 15, affectsDosing: true },
        { kind: 'number', key: 'maxUAMSMBBasalMinutes', label: 'Max UAM SMB basal minutes', unit: 'min', min: 15, max: 120, step: 15, affectsDosing: true },
        { kind: 'number', key: 'smbDeliveryRatio', label: 'SMB delivery ratio', help: 'Share of insulinReq delivered per SMB.', min: 0.3, max: 0.7, step: 0.05, affectsDosing: true },
        { kind: 'number', key: 'smbInterval', label: 'SMB interval', unit: 'min', min: 1, max: 10, step: 1 },
    ],
};
const TARGET_BEHAVIOR = {
    title: 'Target Behavior',
    fields: [
        { kind: 'boolean', key: 'highTempTargetRaisesSensitivity', label: 'High Temp Target Raises Sensitivity', affectsDosing: true },
        { kind: 'boolean', key: 'lowTempTargetLowersSensitivity', label: 'Low Temp Target Lowers Sensitivity', affectsDosing: true },
        { kind: 'boolean', key: 'sensitivityRaisesTarget', label: 'Sensitivity Raises Target', affectsDosing: true },
        { kind: 'boolean', key: 'resistanceLowersTarget', label: 'Resistance Lowers Target', affectsDosing: true },
        { kind: 'number', key: 'halfBasalExerciseTarget', label: 'Half Basal Exercise Target', unit: 'mg/dL', min: 100, max: 400, step: 5 },
    ],
};
const COMMON_SECTIONS = [
    {
        title: 'Sensitivity',
        fields: [
            { kind: 'number', key: 'autosensMax', label: 'Autosens max', min: 1, max: 2, step: 0.05, affectsDosing: true },
            { kind: 'number', key: 'autosensMin', label: 'Autosens min', min: 0.5, max: 1, step: 0.05 },
            { kind: 'boolean', key: 'dynamicIsf', label: 'Dynamic ISF (logarithmic)', help: 'Scale ISF with glucose and TDD (Chris Wilson formula).', affectsDosing: true },
            { kind: 'number', key: 'adjustmentFactor', label: 'Dynamic ISF adjustment factor', min: 0.3, max: 1.5, step: 0.05, affectsDosing: true },
        ],
    },
    {
        title: 'Carbs & thresholds',
        fields: [
            { kind: 'number', key: 'remainingCarbsCap', label: 'Remaining carbs cap', unit: 'g', min: 0, max: 200, step: 5 },
            { kind: 'number', key: 'min5mCarbImpact', label: 'Min 5 m carb impact', unit: 'mg/dL/5m', min: 1, max: 12, step: 1 },
            { kind: 'number', key: 'thresholdSetting', label: 'Low glucose threshold', unit: 'mg/dL', min: 60, max: 120, step: 1 },
            { kind: 'boolean', key: 'skipNeutralTemps', label: 'Skip neutral temps' },
        ],
    },
];
const COMMON_DEFAULTS = {
    enableSMBHighBgTarget: 180,
    maxSMBBasalMinutes: 30,
    maxUAMSMBBasalMinutes: 30,
    smbInterval: 3,
    smbDeliveryRatio: 0.5,
    autosensMax: 1.2,
    autosensMin: 0.7,
    remainingCarbsCap: 90,
    min5mCarbImpact: 8,
    thresholdSetting: 65,
    dynamicIsf: false,
    adjustmentFactor: 0.8,
    skipNeutralTemps: false,
    // Trio Target Behavior defaults
    highTempTargetRaisesSensitivity: false,
    lowTempTargetLowersSensitivity: false,
    sensitivityRaisesTarget: false,
    resistanceLowersTarget: false,
    halfBasalExerciseTarget: 160,
    enableSMBWithTempTarget: false,
    allowSMBWithHighTempTarget: false,
    maxDeltaBGThreshold: 0.2,
    maxCOB: 120,
};
export const orefSmb = defineAlgorithm({
    meta: {
        id: 'oref-smb',
        name: 'oref SMB (Trio)',
        shortName: 'SMB',
        description: 'OpenAPS oref determine-basal as shipped in Trio: temp basals plus Super Micro Boluses and unannounced-meal detection. Four prediction curves (IOB, ZT, COB, UAM).',
        version: 'trio-dev',
        author: 'OpenAPS / Trio contributors',
        maturity: 'reference',
        capabilities: { tempBasal: true, autoBolus: true, predictions: ['iob', 'zt', 'cob', 'uam'] },
    },
    settings: [SMB_SECTION, ...COMMON_SECTIONS, TARGET_BEHAVIOR],
    defaultSettings: {
        ...COMMON_DEFAULTS,
        enableSMB: true,
        enableSMBAlways: false,
        enableSMBWithCOB: true,
        enableSMBAfterCarbs: true,
        enableSMBHighBg: false,
        enableUAM: true,
    },
    decide: (input, settings) => runOref(input, { ...settings, enableSMB: true }),
});
export const orefTempBasal = defineAlgorithm({
    meta: {
        id: 'oref-temp-basal',
        name: 'oref Temp Basal (AMA)',
        shortName: 'AMA',
        description: 'The same oref engine with SMB and UAM switched off: classic OpenAPS "advanced meal assist" that only adjusts temporary basal rates. Gentler, slower, easy to reason about.',
        version: 'trio-dev',
        author: 'OpenAPS / Trio contributors',
        maturity: 'reference',
        capabilities: { tempBasal: true, autoBolus: false, predictions: ['iob', 'zt', 'cob'] },
    },
    settings: [...COMMON_SECTIONS, TARGET_BEHAVIOR],
    defaultSettings: {
        ...COMMON_DEFAULTS,
        enableSMB: false,
        enableSMBAlways: false,
        enableSMBWithCOB: false,
        enableSMBAfterCarbs: false,
        enableSMBHighBg: false,
        enableUAM: false,
    },
    decide: (input, settings) => runOref(input, { ...settings, enableSMB: false, enableUAM: false }),
});
