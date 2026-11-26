import { DEFAULT_ALERT_SETTINGS, isInQuietHours, minuteOfDay, MINUTE, newId, type AlertKind, type AlertSettings, type GlucoseUnit } from '@buddy/core';
import { formatMinutes, formatValue, GLUCOSE_ALARMS, unitLabel, type AlarmMeta } from './alarm-catalog';

/**
 * Glucose alarms as a list (Trio's GlucoseAlert / GlucoseAlertsStore): several alarms per type, each
 * with its own value, repeat, Day / Night window and tone. The alert engine in @buddy/core has one
 * configuration per kind, so `resolveAlertSettings` picks, for the current window, the alarm that
 * applies to each kind and turns the list back into that shape.
 */

export type GlucoseAlarmKind = 'urgentLow' | 'low' | 'forecastLow' | 'high' | 'carbsRequired' | 'fallingFast' | 'risingFast';
export type AlarmWindow = 'always' | 'day' | 'night';

export const ALARM_WINDOWS: readonly { value: AlarmWindow; label: string }[] = [
  { value: 'always', label: 'Day & Night' },
  { value: 'day', label: 'Day' },
  { value: 'night', label: 'Night' },
];

export const windowName = (w: AlarmWindow): string => ALARM_WINDOWS.find((o) => o.value === w)!.label;

export interface GlucoseAlarm {
  readonly id: string;
  readonly kind: GlucoseAlarmKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly window: AlarmWindow;
  /** The kind's primary threshold (`AlarmMeta.values[0]`): mg/dL, g or mg/dL/min. */
  readonly value: number;
  /** Re-notify every this many minutes while active; 0 = once. */
  readonly repeatMinutes: number;
  readonly playsSound: boolean;
  readonly soundId: string;
}

export const MAX_ALARM_NAME = 30;

const KINDS = new Set<AlertKind>(GLUCOSE_ALARMS.map((m) => m.kind));
export const isGlucoseKind = (k: AlertKind): k is GlucoseAlarmKind => KINDS.has(k);

export const metaFor = (kind: GlucoseAlarmKind): AlarmMeta => GLUCOSE_ALARMS.find((m) => m.kind === kind)!;

/** Default tone per kind (ids from alarm-sounds). */
const DEFAULT_SOUND: Readonly<Record<GlucoseAlarmKind, string>> = {
  urgentLow: 'urgent',
  low: 'beacon',
  forecastLow: 'fall',
  high: 'rise',
  carbsRequired: 'chime',
  fallingFast: 'fall',
  risingFast: 'rise',
};

export const defaultSoundFor = (kind: GlucoseAlarmKind): string => DEFAULT_SOUND[kind];

type KindConfig = { readonly enabled: boolean; readonly repeatMinutes: number } & Record<string, number | boolean>;

const cfg = (a: AlertSettings, kind: GlucoseAlarmKind): KindConfig => a[kind] as unknown as KindConfig;

/** A new alarm of `kind` with the engine's default value and repeat. */
export function newAlarm(kind: GlucoseAlarmKind, window: AlarmWindow, existing: readonly GlucoseAlarm[] = []): GlucoseAlarm {
  const meta = metaFor(kind);
  const defaults = cfg(DEFAULT_ALERT_SETTINGS, kind);
  const sameKind = existing.filter((a) => a.kind === kind).length;
  return {
    id: newId('alarm'),
    kind,
    name: sameKind === 0 ? meta.name : `${meta.name} ${sameKind + 1}`,
    enabled: true,
    window,
    value: Number(defaults[meta.values[0]!.field]),
    repeatMinutes: defaults.repeatMinutes,
    playsSound: true,
    soundId: defaultSoundFor(kind),
  };
}

/**
 * Seeds the list from the single-alarm-per-kind shape stored by earlier builds. The old global
 * "Silence Alarms at Night" switch becomes a Day-only window on every alarm but Urgent Low.
 */
export function migrateAlarms(alerts: AlertSettings, idOf: (kind: GlucoseAlarmKind) => string = () => newId('alarm')): GlucoseAlarm[] {
  return GLUCOSE_ALARMS.map((meta): GlucoseAlarm => {
    const kind = meta.kind as GlucoseAlarmKind;
    const c = cfg(alerts, kind);
    return {
      id: idOf(kind),
      kind,
      name: meta.name,
      enabled: kind === 'urgentLow' ? true : c.enabled,
      window: kind !== 'urgentLow' && alerts.quietHours.enabled ? 'day' : 'always',
      value: Number(c[meta.values[0]!.field]),
      repeatMinutes: c.repeatMinutes,
      playsSound: true,
      soundId: defaultSoundFor(kind),
    };
  });
}

/** Windows a (new or edited) alarm of `kind` may take without overlapping another of the same kind. */
export function availableWindows(kind: GlucoseAlarmKind, alarms: readonly GlucoseAlarm[], excludeId?: string): AlarmWindow[] {
  const taken = new Set(alarms.filter((a) => a.kind === kind && a.id !== excludeId).map((a) => a.window));
  if (taken.has('always') || (taken.has('day') && taken.has('night'))) return [];
  const free = ALARM_WINDOWS.map((w) => w.value).filter((w) => !taken.has(w));
  return taken.size > 0 ? free.filter((w) => w !== 'always') : free;
}

/** Kinds that still have room for a new alarm. */
export function addableKinds(alarms: readonly GlucoseAlarm[]): { available: GlucoseAlarmKind[]; unavailable: GlucoseAlarmKind[] } {
  const kinds = GLUCOSE_ALARMS.map((m) => m.kind as GlucoseAlarmKind);
  return { available: kinds.filter((k) => availableWindows(k, alarms).length > 0), unavailable: kinds.filter((k) => availableWindows(k, alarms).length === 0) };
}

/** At least one alarm of each type must remain. */
export const canDelete = (alarm: GlucoseAlarm, alarms: readonly GlucoseAlarm[]): boolean => alarms.filter((a) => a.kind === alarm.kind).length > 1;

export const removeAlarm = (alarms: readonly GlucoseAlarm[], id: string): GlucoseAlarm[] => {
  const alarm = alarms.find((a) => a.id === id);
  return alarm && canDelete(alarm, alarms) ? alarms.filter((a) => a.id !== id) : [...alarms];
};

export const upsertAlarm = (alarms: readonly GlucoseAlarm[], alarm: GlucoseAlarm): GlucoseAlarm[] =>
  alarms.some((a) => a.id === alarm.id) ? alarms.map((a) => (a.id === alarm.id ? alarm : a)) : [...alarms, alarm];

/** Urgent Low can never be disabled or given a window that leaves gaps (safety floor). */
export function normalizeAlarm(alarm: GlucoseAlarm): GlucoseAlarm {
  const name = alarm.name.trim().slice(0, MAX_ALARM_NAME) || metaFor(alarm.kind).name;
  return alarm.kind === 'urgentLow' ? { ...alarm, name, enabled: true, window: 'always' } : { ...alarm, name };
}

export const isNightAt = (quiet: AlertSettings['quietHours'], now: number): boolean => isInQuietHours({ ...quiet, enabled: true }, now);

const coversNow = (w: AlarmWindow, night: boolean): boolean => w === 'always' || (w === 'night' ? night : !night);

/**
 * Engine configuration for `now`: per kind, the first enabled alarm whose window is current (others
 * of that kind are off). `quietHours.enabled` is cleared because the windows are handled here; the
 * Day / Night boundaries are kept from `base`. If Urgent Low has no current alarm the base values stay on.
 */
export function resolveAlertSettings(alarms: readonly GlucoseAlarm[], base: AlertSettings, now: number): AlertSettings {
  const night = isNightAt(base.quietHours, now);
  let next: AlertSettings = { ...base, quietHours: { ...base.quietHours, enabled: false } };
  for (const meta of GLUCOSE_ALARMS) {
    const kind = meta.kind as GlucoseAlarmKind;
    const of = alarms.filter((a) => a.kind === kind);
    if (of.length === 0) continue;
    const active = of.find((a) => a.enabled && coversNow(a.window, night));
    const fallback = kind === 'urgentLow' ? of[0] : undefined;
    const pick = active ?? fallback;
    const current = cfg(base, kind);
    const patch = pick ? { ...current, enabled: kind === 'urgentLow' ? true : Boolean(active), [meta.values[0]!.field]: pick.value, repeatMinutes: pick.repeatMinutes } : { ...current, enabled: false };
    next = { ...next, [kind]: patch };
  }
  return next;
}

/** Milliseconds until the Day / Night boundary after `now` (at least one second). */
export function msUntilNextBoundary(quiet: AlertSettings['quietHours'], now: number): number {
  const m = minuteOfDay(now, quiet.utcOffsetMinutes);
  const sinceMinuteStart = now - Math.floor(now / MINUTE) * MINUTE;
  const deltas = [quiet.startMinute, quiet.endMinute].map((b) => {
    const d = (b - m + 1440) % 1440;
    return d === 0 ? 1440 : d;
  });
  return Math.max(1000, Math.min(...deltas) * MINUTE - sinceMinuteStart);
}

/** "Below 54 mg/dL • Day & Night" for one alarm (GlucoseAlertsRootView.summary). */
export function alarmSummaryOf(alarm: GlucoseAlarm, glucoseUnit: GlucoseUnit): string {
  const meta = metaFor(alarm.kind);
  const spec = meta.values[0]!;
  const comparator = meta.comparator.replace(/\b\w/g, (ch) => ch.toUpperCase());
  const value = spec.unit === 'min' ? formatMinutes(alarm.value) : `${formatValue(alarm.value, spec.unit, glucoseUnit)} ${unitLabel(spec.unit, glucoseUnit)}`;
  return `${comparator} ${value} • ${windowName(alarm.window)}`;
}
