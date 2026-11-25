import { formatGlucose, type AlertKind, type AlertSettings, type GlucoseUnit } from '@buddy/core';

/**
 * Presentation metadata for Buddy's alert kinds, mirroring Trio's GlucoseAlertType /
 * DeviceAlertSeverity copy. Buddy has one fixed configuration per kind (no add/delete),
 * so this maps each kind to Trio's names, blurbs and editor sections.
 */

export type ValueUnit = 'glucose' | 'g' | 'min' | 'U' | '%' | 'rate';

export interface ValueSpec {
  /** Field inside `AlertSettings[kind]`. */
  readonly field: string;
  readonly header: string;
  readonly footer?: string;
  readonly title: string;
  readonly unit: ValueUnit;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export interface AlarmMeta {
  readonly kind: AlertKind;
  readonly name: string;
  readonly blurb: string;
  /** Summary comparator ("Below 54 mg/dL"); omitted for device rows. */
  readonly comparator: 'below' | 'above' | 'at least' | 'after' | 'at or below';
  readonly values: readonly ValueSpec[];
  /** Urgent low is the safety floor: always armed (Trio hides its Enabled toggle). */
  readonly alwaysOn?: boolean;
}

type KindConfig = AlertSettings[AlertKind];

/** Trio order: urgentLow, low, forecastedLow, high, carbsRequired; Buddy's rate alarms after. */
export const GLUCOSE_ALARMS: readonly AlarmMeta[] = [
  {
    kind: 'urgentLow',
    name: 'Urgent Low Glucose',
    blurb: 'Fires when glucose drops to or below an urgent low threshold.',
    comparator: 'below',
    alwaysOn: true,
    values: [{ field: 'threshold', header: 'Urgent Low Threshold', footer: 'Recommended to always override silence and Focus mode.', title: 'Glucose', unit: 'glucose', min: 54, max: 80, step: 1 }],
  },
  {
    kind: 'low',
    name: 'Low Glucose',
    blurb: 'Fires when glucose drops to or below a low threshold.',
    comparator: 'below',
    values: [{ field: 'threshold', header: 'Low Threshold', footer: 'Fires when glucose is at or below this value.', title: 'Glucose', unit: 'glucose', min: 54, max: 100, step: 1 }],
  },
  {
    kind: 'forecastLow',
    name: 'Low Glucose Soon',
    blurb: 'Fires when glucose is forecasted to be low within the next 20 minutes.',
    comparator: 'below',
    values: [
      {
        field: 'threshold',
        header: 'Low Threshold',
        footer: 'Fires when the lowest forecast within the next 20 minutes (across all available prediction curves) is at or below this value.',
        title: 'Glucose',
        unit: 'glucose',
        min: 54,
        max: 100,
        step: 1,
      },
    ],
  },
  {
    kind: 'high',
    name: 'High Glucose',
    blurb: 'Fires when glucose rises to or above a high threshold.',
    comparator: 'above',
    values: [{ field: 'threshold', header: 'High Threshold', footer: 'Fires when glucose is at or above this value.', title: 'Glucose', unit: 'glucose', min: 100, max: 400, step: 1 }],
  },
  {
    kind: 'carbsRequired',
    name: 'Carbs Required',
    blurb: 'Fires when oref recommends eating carbs to avoid a low.',
    comparator: 'at least',
    values: [
      {
        field: 'grams',
        header: 'Carbs Required Threshold',
        footer: 'Fires when the algorithm suggests to eat at least this many grams of carbs to avoid a low.',
        title: 'Carbs',
        unit: 'g',
        min: 5,
        max: 50,
        step: 1,
      },
    ],
  },
  {
    kind: 'fallingFast',
    name: 'Falling Fast',
    blurb: 'Fires when glucose falls at least this fast over the last readings.',
    comparator: 'at least',
    values: [{ field: 'rateMgdlPerMin', header: 'Rate Threshold', footer: 'Fires when the last delta and the short average both fall at least this fast.', title: 'Rate', unit: 'rate', min: 1, max: 5, step: 0.5 }],
  },
  {
    kind: 'risingFast',
    name: 'Rising Fast',
    blurb: 'Fires when glucose rises at least this fast over the last readings.',
    comparator: 'at least',
    values: [{ field: 'rateMgdlPerMin', header: 'Rate Threshold', footer: 'Fires when the last delta and the short average both rise at least this fast.', title: 'Rate', unit: 'rate', min: 1, max: 5, step: 0.5 }],
  },
];

export const DEVICE_ALARMS: readonly AlarmMeta[] = [
  {
    kind: 'notLooping',
    name: 'Not Looping',
    blurb: 'Fires when the loop has not completed successfully for a while. Escalates to a critical alert.',
    comparator: 'after',
    values: [
      { field: 'minutes', header: 'Warning After', title: 'Time', unit: 'min', min: 10, max: 60, step: 5, footer: 'Time-sensitive alert when the last successful loop is older than this.' },
      { field: 'criticalMinutes', header: 'Critical After', title: 'Time', unit: 'min', min: 30, max: 240, step: 10, footer: 'Escalates to a critical alert that overrides Silence & Focus Mode.' },
    ],
  },
  {
    kind: 'staleData',
    name: 'Glucose Data Stale',
    blurb: 'Fires when no CGM reading has arrived for a while.',
    comparator: 'after',
    values: [{ field: 'minutes', header: 'Stale After', title: 'Time', unit: 'min', min: 10, max: 60, step: 5 }],
  },
  {
    kind: 'pumpReservoirLow',
    name: 'Reservoir Low',
    blurb: 'Fires when the pump reservoir runs low. An empty reservoir is a critical alert.',
    comparator: 'at or below',
    values: [{ field: 'units', header: 'Reservoir Threshold', title: 'Reservoir', unit: 'U', min: 5, max: 50, step: 5 }],
  },
  {
    kind: 'pumpBatteryLow',
    name: 'Pump Battery Low',
    blurb: 'Fires when the pump battery runs low.',
    comparator: 'at or below',
    values: [{ field: 'percent', header: 'Battery Threshold', title: 'Battery', unit: '%', min: 5, max: 50, step: 5 }],
  },
];

export const ALARM_META: Readonly<Partial<Record<AlertKind, AlarmMeta>>> = Object.fromEntries(
  [...GLUCOSE_ALARMS, ...DEVICE_ALARMS].map((m) => [m.kind, m]),
);

/** Repeat choices (minutes); 0 = notify once. */
export const REPEAT_OPTIONS = [0, 5, 10, 15, 20, 30, 60, 120, 240].map((m) => ({ value: m, label: m === 0 ? 'Never' : formatMinutes(m) }));

export function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h} hr${h === 1 ? '' : 's'}` : `${m} min`;
}

export function unitLabel(unit: ValueUnit, glucoseUnit: GlucoseUnit): string {
  switch (unit) {
    case 'glucose':
      return glucoseUnit;
    case 'rate':
      return 'mg/dL/min';
    default:
      return unit;
  }
}

export function formatValue(value: number, unit: ValueUnit, glucoseUnit: GlucoseUnit): string {
  if (unit === 'glucose') return formatGlucose(value, glucoseUnit);
  if (unit === 'rate') return value.toFixed(1);
  return String(Math.round(value));
}

export function readValue(cfg: KindConfig, field: string): number {
  const v = (cfg as unknown as Record<string, unknown>)[field];
  return typeof v === 'number' ? v : 0;
}

/** Picker values from min to max inclusive (step-safe for 0.5 steps). */
export function pickerValues(spec: ValueSpec): number[] {
  const count = Math.round((spec.max - spec.min) / spec.step);
  return Array.from({ length: count + 1 }, (_, i) => Math.round((spec.min + i * spec.step) * 10) / 10);
}

export type ActiveWindow = 'always' | 'day';

/** Buddy's night window (quiet hours) silences everything except urgent low. */
export function activeWindow(kind: AlertKind, quiet: AlertSettings['quietHours']): ActiveWindow {
  return kind === 'urgentLow' || !quiet.enabled ? 'always' : 'day';
}

export function windowLabel(w: ActiveWindow): string {
  return w === 'always' ? 'Day & Night' : 'Day only';
}

/** "Below 54 mg/dL • Day & Night" (GlucoseAlertsRootView.summary). */
export function alarmSummary(meta: AlarmMeta, settings: AlertSettings, glucoseUnit: GlucoseUnit): string {
  const spec = meta.values[0]!;
  const v = readValue(settings[meta.kind], spec.field);
  const comparator = meta.comparator.replace(/\b\w/g, (ch) => ch.toUpperCase());
  const value = spec.unit === 'min' ? formatMinutes(v) : `${formatValue(v, spec.unit, glucoseUnit)} ${unitLabel(spec.unit, glucoseUnit)}`;
  return `${comparator} ${value} • ${windowLabel(activeWindow(meta.kind, settings.quietHours))}`;
}

/** Whether a kind can reach iOS as a critical alert (overrides Silence & Focus). */
export function overridesFocus(kind: AlertKind): boolean {
  return kind === 'urgentLow' || kind === 'notLooping' || kind === 'pumpReservoirLow';
}

export function isEnabled(kind: AlertKind, settings: AlertSettings): boolean {
  return kind === 'urgentLow' || settings[kind].enabled;
}

/** Returns new AlertSettings with one kind's fields patched (immutable). */
export function patchKind(settings: AlertSettings, kind: AlertKind, patch: Record<string, number | boolean>): AlertSettings {
  return { ...settings, [kind]: { ...settings[kind], ...patch } };
}
