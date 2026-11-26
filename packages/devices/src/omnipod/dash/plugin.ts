/**
 * Buddy plugin definition for the TypeScript port of OmnipodKit's DASH support
 * (MIT License, (c) LoopKit Authors). Settings mirror the DASH defaults of OmnipodKit
 * (`OmniPumpManagerState`: 10 U low reservoir reminder, 2 h expiration reminder).
 *
 * BENCH USE ONLY: the pod is filled with water and never attached to a body.
 */
import { definePump, type DeviceContext, type SettingsSection } from '@buddy/core';
import type { OmnipodDashSettings, OmnipodDriverOptions } from './driver-core';
import { OMNIPOD_DASH_META, OmnipodDashDriver } from './driver';

export const OMNIPOD_DASH_SETTINGS: SettingsSection[] = [
  {
    title: 'Pod alerts',
    fields: [
      {
        kind: 'number',
        key: 'lowReservoirUnits',
        label: 'Low reservoir alert',
        help: 'The pod beeps when this many units are left (0 = off). Applied when the cannula insertion starts.',
        unit: 'U',
        min: 0,
        max: 50,
        step: 1,
      },
      {
        kind: 'number',
        key: 'expirationReminderHours',
        label: 'Expiration reminder',
        help: 'Hours before the nominal pod life (72 h) at which the pod reminds you (0 = off).',
        unit: 'h',
        min: 0,
        max: 24,
        step: 1,
      },
      { kind: 'boolean', key: 'silentAlerts', label: 'Silent alerts', help: 'The pod still raises its alerts, but without sound.' },
    ],
  },
];

export const OMNIPOD_DASH_DEFAULTS: OmnipodDashSettings = {
  lowReservoirUnits: 10,
  expirationReminderHours: 2,
  silentAlerts: false,
};

/** Builds the driver directly (tests and the setup UI may pass transport timeouts). */
export const createOmnipodDashDriver = (settings: OmnipodDashSettings, ctx: DeviceContext, options?: OmnipodDriverOptions): OmnipodDashDriver =>
  new OmnipodDashDriver(settings, ctx, options);

export const omnipodDashPump = definePump<OmnipodDashSettings>({
  meta: OMNIPOD_DASH_META,
  settings: OMNIPOD_DASH_SETTINGS,
  defaultSettings: OMNIPOD_DASH_DEFAULTS,
  create: (settings, ctx) => createOmnipodDashDriver(settings, ctx),
});
