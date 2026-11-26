/**
 * Buddy plugin wrapper for the TypeScript port of loopandlearn/DanaKit (MIT, © 2021 Randall
 * Knutson and the DanaKit authors). Settings mirror DanaKitPumpManagerState.swift (device name,
 * bolus speed, automatic time sync) plus the expected model (BLE5 Dana-i vs Dana RS v3).
 */
import { createMemorySecretStore, definePump, type DeviceMeta, type SettingsSection } from '@buddy/core';
import { DanaPumpDriver, type DanaModel } from './driver';
import { DEVICE_NAME_REGEX } from './link';
import { BolusSpeed } from './packets/bolus';
import { DanaStore, secretKey } from './persisted';

export interface DanaSettings {
  readonly [key: string]: string | number | boolean;
  deviceName: string;
  model: DanaModel;
  bolusSpeed: '12' | '30' | '60';
  autoTimeSync: boolean;
}

export const DANA_META: DeviceMeta = {
  id: 'dana-i',
  name: 'Dana-i / Dana RS',
  manufacturer: 'Sooil',
  description:
    'Experimental Bluetooth driver for the Sooil Dana-i (BLE5) and Dana RS (v3), ported from DanaKit. Never verified on hardware by Buddy: test with a pump that is not worn before any use.',
  transport: 'ble',
  maturity: 'experimental',
};

const SETTINGS: SettingsSection[] = [
  {
    title: 'Pump',
    fields: [
      {
        kind: 'text',
        key: 'deviceName',
        label: 'Pump name / serial',
        help: 'The Bluetooth name shown on the pump (3 letters, 5 digits, 2 letters), e.g. ABC12345DE.',
        placeholder: 'ABC12345DE',
      },
      {
        kind: 'select',
        key: 'model',
        label: 'Model',
        help: 'The encryption is detected during the handshake; a specific model makes the driver refuse any other.',
        options: [
          { value: 'auto', label: 'Detect automatically' },
          { value: 'dana-i', label: 'Dana-i (BLE5)' },
          { value: 'dana-rs', label: 'Dana RS (v3, PIN pairing)' },
        ],
      },
      {
        kind: 'select',
        key: 'bolusSpeed',
        label: 'Bolus speed',
        options: [
          { value: '12', label: '12 sec/U' },
          { value: '30', label: '30 sec/U' },
          { value: '60', label: '60 sec/U' },
        ],
      },
      { kind: 'boolean', key: 'autoTimeSync', label: 'Sync pump time automatically', help: 'Sets the pump clock when its date differs from the phone.' },
    ],
  },
];

const DEFAULTS: DanaSettings = { deviceName: '', model: 'auto', bolusSpeed: '12', autoTimeSync: true };

const toBolusSpeed = (s: string): BolusSpeed => (s === '60' ? BolusSpeed.speed60 : s === '30' ? BolusSpeed.speed30 : BolusSpeed.speed12);
const toModel = (s: string): DanaModel => (s === 'dana-i' || s === 'dana-rs' ? s : 'auto');

export const danaPump = definePump<DanaSettings>({
  meta: DANA_META,
  settings: SETTINGS,
  defaultSettings: DEFAULTS,
  create(settings, ctx): DanaPumpDriver {
    if (!ctx.ble) throw new Error('Dana-i / Dana RS needs Bluetooth: no BLE transport is available on this device.');
    const deviceName = String(settings.deviceName ?? '').trim();
    if (!DEVICE_NAME_REGEX.test(deviceName)) {
      throw new Error(`Dana-i / Dana RS: invalid pump name "${deviceName}". Enter the 10-character Bluetooth name shown on the pump (e.g. ABC12345DE).`);
    }
    const secrets = ctx.secrets ?? createMemorySecretStore();
    if (!ctx.secrets) ctx.log.warn('Dana: no secure storage available; pairing keys are kept in memory only');
    const store = new DanaStore(secrets, secretKey(deviceName), ctx.log);
    return new DanaPumpDriver(
      DANA_META,
      { deviceName, expectedModel: toModel(String(settings.model)), bolusSpeed: toBolusSpeed(String(settings.bolusSpeed)), autoTimeSync: settings.autoTimeSync !== false },
      ctx.ble,
      store,
      ctx.clock,
      ctx.log,
    );
  },
});
