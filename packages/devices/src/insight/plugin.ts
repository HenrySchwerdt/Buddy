/**
 * Buddy plugin definition for the Accu-Chek Insight (TypeScript port of InsightKit, written by the
 * Buddy owner). Settings mirror InsightKit's state: the paired bridge, the dosing limits, the basal
 * profile and automatic time sync. The pairing key is a secret setting; the driver also finds it in
 * the `SecretStore` (keyed by bridge id) where `pairInsightBridge` writes it.
 */
import { definePump, type DeviceContext, type SettingsSection } from '@buddy/core';
import { InsightPumpDriver, INSIGHT_META } from './driver';
import type { InsightDriverOptions, InsightSettings } from './driver-core';

export const INSIGHT_SETTINGS: SettingsSection[] = [
  {
    title: 'InsightBridge',
    fields: [
      {
        kind: 'text',
        key: 'bridgeId',
        label: 'Paired bridge',
        help: 'The id of the InsightBridge app this phone is paired with. Set by pairing in the pump setup; changing it forgets the pairing.',
        placeholder: 'Pair in the setup',
      },
      { kind: 'text', key: 'bridgeName', label: 'Bridge name', help: 'Shown in the pump settings.' },
      { kind: 'text', key: 'bridgePeripheral', label: 'Last Bluetooth address', help: 'Updated automatically: the bridge rotates its Bluetooth address.' },
      {
        kind: 'text',
        key: 'pairingSecret',
        label: 'Pairing key',
        help: 'Written by pairing. Keep it private: whoever has it can control the pump through the bridge.',
        secret: true,
      },
    ],
  },
  {
    title: 'Limits',
    fields: [
      {
        kind: 'number',
        key: 'maxBolus',
        label: 'Maximum bolus',
        help: 'The driver refuses any bolus above this (and above the pump\'s own limit).',
        unit: 'U',
        min: 0.05,
        max: 25,
        step: 0.05,
        affectsDosing: true,
      },
      {
        kind: 'number',
        key: 'maxBasal',
        label: 'Maximum basal rate',
        help: 'The driver refuses any temp basal above this (and above the pump\'s own limit).',
        unit: 'U/h',
        min: 0.05,
        max: 25,
        step: 0.05,
        affectsDosing: true,
      },
    ],
  },
  {
    title: 'Basal profile',
    fields: [
      {
        kind: 'text',
        key: 'basalProfile',
        label: 'Hourly basal rates',
        help: 'The 24 hourly basal rates in U/h from midnight, separated by commas (one value = flat profile). The Insight changes only on full hours. Temp basals are percentages of this profile, so it must match the pump.',
        placeholder: '0.8, 0.8, 0.8, 0.8, 0.9, 1.0, ...',
      },
    ],
  },
  {
    title: 'Pump',
    fields: [{ kind: 'boolean', key: 'autoTimeSync', label: 'Sync pump time automatically', help: 'Sets the pump clock when it differs by more than 5 minutes from the phone.' }],
  },
];

export const INSIGHT_DEFAULTS: InsightSettings = {
  bridgeId: '',
  bridgeName: '',
  bridgePeripheral: '',
  pairingSecret: '',
  maxBolus: 10,
  maxBasal: 10,
  basalProfile: '',
  autoTimeSync: true,
};

/** Builds the driver directly (tests and the setup screen may pass a client or timeouts). */
export const createInsightDriver = (settings: InsightSettings, ctx: DeviceContext, options?: InsightDriverOptions): InsightPumpDriver => new InsightPumpDriver(settings, ctx, options);

export const accuChekInsightPump = definePump<InsightSettings>({
  meta: INSIGHT_META,
  settings: INSIGHT_SETTINGS,
  defaultSettings: INSIGHT_DEFAULTS,
  create: (settings, ctx) => createInsightDriver(settings, ctx),
});
