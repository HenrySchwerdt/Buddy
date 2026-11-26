import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from '@buddy/core';
import { addableKinds, alarmSummaryOf, availableWindows, canDelete, migrateAlarms, msUntilNextBoundary, newAlarm, normalizeAlarm, removeAlarm, resolveAlertSettings, upsertAlarm, type GlucoseAlarm } from '../alarms';

const ids = (kind: string) => `id-${kind}`;
const DAY_NOON = Date.UTC(2026, 10, 26, 12, 0);
const NIGHT_2AM = Date.UTC(2026, 10, 26, 2, 0);
const base: AlertSettings = { ...DEFAULT_ALERT_SETTINGS, quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 6 * 60, utcOffsetMinutes: 0 } };

describe('migrateAlarms', () => {
  it('seeds one alarm per glucose kind from the single-alarm shape', () => {
    const alarms = migrateAlarms({ ...base, low: { ...base.low, threshold: 80, enabled: false, repeatMinutes: 30 } }, ids);
    expect(alarms.map((a) => a.kind)).toEqual(['urgentLow', 'low', 'forecastLow', 'high', 'carbsRequired', 'fallingFast', 'risingFast']);
    const low = alarms.find((a) => a.kind === 'low')!;
    expect(low).toMatchObject({ value: 80, enabled: false, repeatMinutes: 30, window: 'always', name: 'Low Glucose' });
    expect(alarms.find((a) => a.kind === 'carbsRequired')!.value).toBe(10);
  });

  it('turns the global night silence into Day-only windows, except Urgent Low', () => {
    const alarms = migrateAlarms({ ...base, quietHours: { ...base.quietHours, enabled: true } }, ids);
    expect(alarms.find((a) => a.kind === 'urgentLow')!.window).toBe('always');
    expect(alarms.filter((a) => a.kind !== 'urgentLow').every((a) => a.window === 'day')).toBe(true);
  });

  it('round-trips: resolving the migrated list reproduces the engine settings', () => {
    const original: AlertSettings = { ...base, high: { ...base.high, threshold: 250 }, fallingFast: { ...base.fallingFast, enabled: true, rateMgdlPerMin: 2 } };
    const resolved = resolveAlertSettings(migrateAlarms(original, ids), original, DAY_NOON);
    expect(resolved).toEqual(original);
  });
});

describe('windows', () => {
  const low = (id: string, window: GlucoseAlarm['window']): GlucoseAlarm => ({ ...newAlarm('low', window), id });

  it('offers every window when the kind has no alarm yet', () => {
    expect(availableWindows('low', [])).toEqual(['always', 'day', 'night']);
  });
  it('blocks everything once Day & Night is taken', () => {
    expect(availableWindows('low', [low('a', 'always')])).toEqual([]);
  });
  it('offers only the other window once Day is taken (never Day & Night)', () => {
    expect(availableWindows('low', [low('a', 'day')])).toEqual(['night']);
  });
  it('is full when Day and Night are both taken', () => {
    expect(availableWindows('low', [low('a', 'day'), low('b', 'night')])).toEqual([]);
  });
  it('lets an edited alarm keep its own window', () => {
    expect(availableWindows('low', [low('a', 'always')], 'a')).toEqual(['always', 'day', 'night']);
  });
  it('splits kinds into available and unavailable for the add sheet', () => {
    const alarms = [...migrateAlarms(base, ids)];
    const r = addableKinds(alarms);
    expect(r.available).toEqual([]);
    expect(r.unavailable).toHaveLength(7);
    const day = alarms.map((a) => (a.kind === 'low' ? { ...a, window: 'day' as const } : a));
    expect(addableKinds(day).available).toEqual(['low']);
  });
});

describe('list editing', () => {
  const alarms = migrateAlarms(base, ids);

  it('keeps the last alarm of a type', () => {
    expect(canDelete(alarms[1]!, alarms)).toBe(false);
    expect(removeAlarm(alarms, alarms[1]!.id)).toHaveLength(alarms.length);
  });
  it('deletes when another alarm of the type exists', () => {
    const extra = { ...newAlarm('low', 'night'), id: 'x' };
    const list = upsertAlarm(alarms, extra);
    expect(list).toHaveLength(alarms.length + 1);
    expect(removeAlarm(list, 'x')).toHaveLength(alarms.length);
  });
  it('upsert replaces by id', () => {
    const changed = upsertAlarm(alarms, { ...alarms[1]!, value: 90 });
    expect(changed).toHaveLength(alarms.length);
    expect(changed[1]!.value).toBe(90);
  });
  it('names additional alarms of a type with a counter', () => {
    expect(newAlarm('low', 'day', alarms).name).toBe('Low Glucose 2');
  });
  it('keeps Urgent Low on and always active', () => {
    const n = normalizeAlarm({ ...alarms[0]!, enabled: false, window: 'night', name: '  ' });
    expect(n).toMatchObject({ enabled: true, window: 'always', name: 'Urgent Low Glucose' });
  });
});

describe('resolveAlertSettings', () => {
  const split = (): GlucoseAlarm[] => {
    const seeded = migrateAlarms(base, ids).map((a) => (a.kind === 'low' ? { ...a, window: 'day' as const, value: 72 } : a));
    return [...seeded, { ...newAlarm('low', 'night'), id: 'night-low', value: 60, repeatMinutes: 30 }];
  };

  it('uses the Day alarm by day and the Night alarm by night', () => {
    expect(resolveAlertSettings(split(), base, DAY_NOON).low).toMatchObject({ enabled: true, threshold: 72 });
    expect(resolveAlertSettings(split(), base, NIGHT_2AM).low).toMatchObject({ enabled: true, threshold: 60, repeatMinutes: 30 });
  });

  it('switches the kind off when no enabled alarm covers the window', () => {
    const alarms = split().map((a) => (a.id === 'night-low' ? { ...a, enabled: false } : a));
    expect(resolveAlertSettings(alarms, base, NIGHT_2AM).low.enabled).toBe(false);
  });

  it('never switches Urgent Low off', () => {
    const alarms = migrateAlarms(base, ids).map((a) => (a.kind === 'urgentLow' ? { ...a, enabled: false, window: 'day' as const } : a));
    expect(resolveAlertSettings(alarms, base, NIGHT_2AM).urgentLow.enabled).toBe(true);
  });

  it('handles the windows wrapping past midnight and clears the global silence flag', () => {
    const quiet = { ...base, quietHours: { ...base.quietHours, enabled: true } };
    expect(resolveAlertSettings(migrateAlarms(quiet, ids), quiet, NIGHT_2AM).quietHours.enabled).toBe(false);
    expect(resolveAlertSettings(migrateAlarms(quiet, ids), quiet, NIGHT_2AM).high.enabled).toBe(false);
    expect(resolveAlertSettings(migrateAlarms(quiet, ids), quiet, DAY_NOON).high.enabled).toBe(true);
  });
});

describe('msUntilNextBoundary', () => {
  it('counts to the next day or night start', () => {
    expect(msUntilNextBoundary(base.quietHours, DAY_NOON)).toBe(10 * 3_600_000);
    expect(msUntilNextBoundary(base.quietHours, NIGHT_2AM)).toBe(4 * 3_600_000);
  });
  it('rolls to the next boundary exactly on one', () => {
    expect(msUntilNextBoundary(base.quietHours, Date.UTC(2026, 10, 26, 6, 0))).toBe(16 * 3_600_000);
  });
});

describe('alarmSummaryOf', () => {
  it('words value and window', () => {
    expect(alarmSummaryOf({ ...newAlarm('low', 'night'), value: 65 }, 'mg/dL')).toBe('Below 65 mg/dL • Night');
    expect(alarmSummaryOf(newAlarm('carbsRequired', 'always'), 'mmol/L')).toBe('At Least 10 g • Day & Night');
  });
});
