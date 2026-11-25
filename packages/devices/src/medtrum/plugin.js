/**
 * Buddy plugin definition for the TypeScript port of loopandlearn/MedtrumKit
 * (MIT License, (c) the original MedtrumKit authors). Settings mirror MedtrumKit's onboarding
 * (`PumpBaseSettingsViewModel`, `PatchSettingsViewModel`) and `MedtrumPumpState` defaults.
 */
import { definePump } from '@buddy/core';
import { MEDTRUM_NANO_META, MedtrumNanoDriver } from './driver';
const ALARM_LABELS = {
    LightVibrateAndBeep: 'Light, vibrate and beep',
    LightAndVibrate: 'Light and vibrate',
    LightAndBeep: 'Light and beep',
    LightOnly: 'Light only',
    VibrateAndBeep: 'Vibrate and beep',
    VibrateOnly: 'Vibrate only',
    BeepOnly: 'Beep only',
    None: 'None',
};
export const MEDTRUM_NANO_SETTINGS = [
    {
        title: 'Pump base',
        fields: [
            {
                kind: 'text',
                key: 'serialNumber',
                label: 'Pump base serial number',
                help: '8 hexadecimal characters printed on the pump base (e.g. AA76F9D9). Changing it forgets the paired base.',
                placeholder: 'AA76F9D9',
            },
        ],
    },
    {
        title: 'Patch settings',
        fields: [
            {
                kind: 'select',
                key: 'alarmSetting',
                label: 'Patch alarms',
                options: Object.keys(ALARM_LABELS).map((k) => ({ value: k, label: ALARM_LABELS[k] })),
            },
            {
                kind: 'select',
                key: 'expiryMode',
                label: 'Patch expiry',
                help: 'Default: 12 h reminder and expiry after 3 days (+8 h grace). Extended: no automatic expiry.',
                options: [
                    { value: 'default', label: 'Default (72 h)' },
                    { value: 'extended', label: 'Extended' },
                ],
            },
            {
                kind: 'number',
                key: 'maxHourlyInsulin',
                label: 'Patch hourly maximum',
                help: 'The patch suspends itself when more than this was delivered within an hour.',
                unit: 'U',
                min: 0.05,
                max: 40,
                step: 0.05,
                affectsDosing: true,
            },
            {
                kind: 'number',
                key: 'maxDailyInsulin',
                label: 'Patch daily maximum',
                help: 'The patch suspends itself when more than this was delivered within a day.',
                unit: 'U',
                min: 0.05,
                max: 180,
                step: 0.05,
                affectsDosing: true,
            },
        ],
    },
];
/** `MedtrumPumpState` defaults: hourly max 20 U, daily max 100 U, BeepOnly, default expiry. */
export const MEDTRUM_NANO_DEFAULTS = {
    serialNumber: '',
    alarmSetting: 'BeepOnly',
    expiryMode: 'default',
    maxHourlyInsulin: 20,
    maxDailyInsulin: 100,
};
/** Builds the driver directly (tests and the activation UI may pass transport timeouts). */
export const createMedtrumNanoDriver = (settings, ctx, options) => new MedtrumNanoDriver(settings, ctx, options);
export const medtrumNanoPump = definePump({
    meta: MEDTRUM_NANO_META,
    settings: MEDTRUM_NANO_SETTINGS,
    defaultSettings: MEDTRUM_NANO_DEFAULTS,
    create: (settings, ctx) => createMedtrumNanoDriver(settings, ctx),
});
