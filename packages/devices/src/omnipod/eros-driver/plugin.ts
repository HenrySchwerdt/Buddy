/**
 * Buddy plugin definition for the Omnipod Eros driver, a TypeScript port of the Eros parts of
 * OmnipodKit (MIT License, (c) LoopKit Authors). Alert settings mirror the OmnipodKit defaults
 * (10 U low reservoir reminder, 2 h expiration reminder).
 *
 * BENCH USE ONLY: the pod is filled with water and never attached to a body.
 */
import { definePump, type DeviceContext, type SettingsSection } from '@buddy/core';
import type { ErosDriverOptions, OmnipodErosSettings } from './driver-core';
import { OMNIPOD_EROS_META, OmnipodErosDriver } from './driver';

export const OMNIPOD_EROS_SETTINGS: SettingsSection[] = [
  {
    title: 'RileyLink',
    fields: [
      {
        kind: 'text',
        key: 'rileyLinkId',
        label: 'RileyLink',
        help: 'The RileyLink (or compatible bridge) that talks to the pod. Pick it in the pump setup.',
        placeholder: 'Not selected',
      },
    ],
  },
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

export const OMNIPOD_EROS_DEFAULTS: OmnipodErosSettings = {
  rileyLinkId: '',
  lowReservoirUnits: 10,
  expirationReminderHours: 2,
  silentAlerts: false,
};

/** Builds the driver directly (tests and the setup UI may pass radio timing options). */
export const createOmnipodErosDriver = (settings: OmnipodErosSettings, ctx: DeviceContext, options?: ErosDriverOptions): OmnipodErosDriver =>
  new OmnipodErosDriver(settings, ctx, options);

export const omnipodErosPump = definePump<OmnipodErosSettings>({
  meta: OMNIPOD_EROS_META,
  settings: OMNIPOD_EROS_SETTINGS,
  defaultSettings: OMNIPOD_EROS_DEFAULTS,
  create: (settings, ctx) => createOmnipodErosDriver(settings, ctx),
});
