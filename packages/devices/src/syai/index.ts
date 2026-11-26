/**
 * Syai Ultra CGM plugin. Port of SyaiKit (MIT, © 2026 Nightscout Foundation), the Trio/Loop
 * driver for the Syai Ultra (X1) sensor: BLE protocol, pairing keys from the user's own Syai
 * account, glucose decoding, backfill and sensor lifecycle. Not a medical device.
 */
import { defineCgm } from '@buddy/core';
import { createSyaiSource, SYAI_META, type SyaiSettings } from './source';

export * from './constants';
export * from './errors';
export * from './bytes';
export * from './frames';
export * from './rpn';
export * from './notify-info';
export * from './ble-auth';
export * from './backfill';
export * from './plausibility';
export * from './lifecycle';
export * from './provisioning';
export * from './cloud-channel';
export * from './cloud-client';
export * from './state';
export * from './gatt';
export { SyaiSession, locateSensor, type BatchStatus, type SessionHandlers, type SessionEnv, type SessionTarget, type SessionTimeouts } from './session';
export { SyaiManager, trendFromSyaiRate, type SyaiManagerDeps } from './manager';
export { createSyaiSource, normalizeSensorMac, SYAI_META, DEFAULT_RETRY_TIMING, type SyaiSettings, type SyaiSourceOptions, type SyaiCgmSource, type SyaiStatus, type SyaiRetryTiming } from './source';

export const syaiCgm = defineCgm<SyaiSettings>({
  meta: SYAI_META,
  settings: [
    {
      title: 'Syai account',
      fields: [
        { kind: 'text', key: 'email', label: 'Email', placeholder: 'you@example.com', help: 'The account you use in the official Syai app. It holds your sensor keys and calibration; the sensor must already be activated and bound to it.' },
        { kind: 'text', key: 'password', label: 'Password', secret: true, help: 'Stored in the keychain. Only used to sign in to Syai.' },
      ],
    },
    {
      title: 'Sensor',
      fields: [
        {
          kind: 'text',
          key: 'sensorMac',
          label: 'Sensor code (optional)',
          placeholder: 'AABBCCDDEEFF',
          help: 'The 12-digit code from the QR code on the applicator. Leave empty to use the sensor bound to your account. Close the official Syai app: the sensor talks to one device at a time.',
        },
      ],
    },
  ],
  defaultSettings: { email: '', password: '', sensorMac: '' },
  create: (settings, ctx) => createSyaiSource(settings, ctx),
});
