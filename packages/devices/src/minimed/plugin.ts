/**
 * Buddy plugin definition for the Medtronic MiniMed driver, a TypeScript port of MinimedKit
 * (migrated from ps2/rileylink_ios, MIT License, (c) LoopKit Authors).
 *
 * Experimental: nothing here has run on a real pump.
 */
import { definePump, type DeviceContext, type SettingsSection } from '@buddy/core';
import { MinimedDriver, MINIMED_META } from './driver';
import type { MinimedDriverOptions, MinimedSettings } from './driver-core';
import { PUMP_MODELS } from './models';

export const MINIMED_SETTINGS: SettingsSection[] = [
  {
    title: 'RileyLink',
    fields: [
      {
        kind: 'text',
        key: 'rileyLinkId',
        label: 'RileyLink',
        help: 'The RileyLink (or compatible bridge) that talks to the pump. Pick it in the pump setup.',
        placeholder: 'Not selected',
      },
    ],
  },
  {
    title: 'Pump',
    fields: [
      {
        kind: 'text',
        key: 'pumpSerial',
        label: 'Pump serial number',
        help: 'The 6 digits printed on the back of the pump (also under Utilities, Connect Devices on the pump).',
        placeholder: '123456',
      },
      {
        kind: 'select',
        key: 'pumpRegion',
        label: 'Pump region',
        help: 'North America pumps talk on 916 MHz, world-wide pumps on 868 MHz.',
        options: [
          { value: 'NA', label: 'North America' },
          { value: 'WW', label: 'World-wide' },
        ],
      },
      {
        kind: 'select',
        key: 'pumpModel',
        label: 'Pump model',
        help: 'The model number on the back of the pump. The driver reads the real model from the pump and uses that.',
        options: PUMP_MODELS.map((m) => ({ value: m, label: m })),
      },
    ],
  },
];

export const MINIMED_DEFAULTS: MinimedSettings = {
  rileyLinkId: '',
  pumpSerial: '',
  pumpRegion: 'NA',
  pumpModel: '723',
};

/** Builds the driver directly (tests and the setup UI may pass timing options). */
export const createMinimedDriver = (settings: MinimedSettings, ctx: DeviceContext, options?: MinimedDriverOptions): MinimedDriver => new MinimedDriver(settings, ctx, options);

export const minimedPump = definePump<MinimedSettings>({
  meta: MINIMED_META,
  settings: MINIMED_SETTINGS,
  defaultSettings: MINIMED_DEFAULTS,
  create: (settings, ctx) => createMinimedDriver(settings, ctx),
});
