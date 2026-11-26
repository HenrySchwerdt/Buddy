import type { CarbEntry, GlucoseReading, InsulinDose, TherapyProfile } from '@buddy/core';
import { describe, expect, it } from 'vitest';
import {
  doseSelectors,
  mapCarbs,
  mapDeviceEvents,
  mapDoses,
  mapGlucoseReadings,
  mapPumpSettings,
  mapScheduledBasal,
  md5Hex,
  resolvedTypedId,
  type PumpSettingsSnapshot,
  type TidepoolDeviceEvent,
} from '../src';
import { CLIENT_NAME, CLIENT_VERSION, HOUR, MIN, T0, USER_ID, ctx, iso } from './fixtures';

const origin = (id: string) => ({ id, name: CLIENT_NAME, version: CLIENT_VERSION, type: 'application' });
const typedOrigin = (syncId: string, type: string) => origin(resolvedTypedId(syncId, type));
const idOf = (resolved: string) => md5Hex(`${USER_ID}:${resolved}`);

describe('glucose', () => {
  const reading = (over: Partial<GlucoseReading> = {}): GlucoseReading => ({ date: T0, value: 152, trend: 'fortyFiveUp', source: 'cgm', ...over });

  it('maps a CGM reading to cbg with a stable, pinned identity', () => {
    const [m] = mapGlucoseReadings([reading()], ctx());
    expect(m!.revisedAt).toBe(T0);
    expect(m!.datum).toEqual({
      type: 'cbg',
      time: iso(T0),
      value: 152,
      units: 'mg/dL',
      trend: 'slowRise',
      // md5("user-1234:" + md5("provenanceIdentifier:org.nightscout.Buddy:syncIdentifier:cgm:<ms>"))
      id: '0a241ee59c299207cb0906f2279f00cc',
      origin: origin('c4f787dc5135ba7e19a8adff137e4393'),
      payload: { syncIdentifier: `cgm:${T0}` },
    });
  });

  it('maps every trend the way TidepoolService maps Loop trends', () => {
    const trends = ['doubleUp', 'singleUp', 'fortyFiveUp', 'flat', 'fortyFiveDown', 'singleDown', 'doubleDown'] as const;
    const out = mapGlucoseReadings(trends.map((trend, i) => reading({ trend, date: T0 + i })), ctx()).map((m) => ('trend' in m.datum ? m.datum.trend : undefined));
    expect(out).toEqual(['rapidRise', 'moderateRise', 'slowRise', 'constant', 'slowFall', 'moderateFall', 'rapidFall']);
    expect(mapGlucoseReadings([reading({ trend: 'unknown' })], ctx())[0]!.datum).not.toHaveProperty('trend');
    expect(mapGlucoseReadings([reading({ trend: undefined })], ctx())[0]!.datum).not.toHaveProperty('trend');
  });

  it('sends fingersticks as smbg', () => {
    const [m] = mapGlucoseReadings([reading({ source: 'manual', trend: undefined })], ctx());
    expect(m!.datum).toMatchObject({ type: 'smbg', subType: 'manual', value: 152, units: 'mg/dL' });
    const [other] = mapGlucoseReadings([reading({ source: 'finger' })], ctx({ manualGlucoseSources: ['finger'] }));
    expect(other!.datum.type).toBe('smbg');
  });

  it('clamps to Tidepool\'s range, rounds float noise, and skips unusable and Nightscout-sourced readings', () => {
    const out = mapGlucoseReadings(
      [reading({ value: 1500, date: T0 }), reading({ value: 100.123456, date: T0 + 1 }), reading({ value: 0, date: T0 + 2 }), reading({ value: NaN, date: T0 + 3 }), reading({ source: 'nightscout', date: T0 + 4 }), reading({ source: 'nightscout-follow', date: T0 + 5 })],
      ctx(),
    );
    expect(out.map((m) => ('value' in m.datum ? m.datum.value : null))).toEqual([1000, 100.123]);
  });

  it('adds the CGM device id and keeps ids distinct per source and time', () => {
    const out = mapGlucoseReadings([reading(), reading({ source: 'other' }), reading({ date: T0 + MIN })], ctx({ deviceIds: { cgm: 'Dexcom_G7_123' } }));
    expect(new Set(out.map((m) => m.datum.id)).size).toBe(3);
    expect(out.every((m) => m.datum.deviceId === 'Dexcom_G7_123')).toBe(true);
  });

  it('a different account gets different ids for the same reading', () => {
    expect(mapGlucoseReadings([reading()], ctx({ userId: 'other-user' }))[0]!.datum.id).not.toBe(mapGlucoseReadings([reading()], ctx())[0]!.datum.id);
  });
});

describe('carbs', () => {
  const carb = (over: Partial<CarbEntry & { fat: number; protein: number }> = {}): CarbEntry & { fat?: number; protein?: number } => ({ id: 'carb-1', date: T0, grams: 45.5, absorptionHours: 3, note: ' Pasta ', ...over });

  it('maps to food with net carbohydrate, absorption seconds and the note as name', () => {
    const [m] = mapCarbs([carb({ fat: 12, protein: 8 })], ctx());
    expect(m!.datum).toEqual({
      type: 'food',
      time: iso(T0),
      name: 'Pasta',
      nutrition: {
        carbohydrate: { net: 45.5, units: 'grams' },
        fat: { total: 12, units: 'grams' },
        protein: { total: 8, units: 'grams' },
        estimatedAbsorptionDuration: 10_800,
      },
      id: '570f71674130826ea1e75e5553664fe9',
      origin: origin('cac20ac59d209ffe75e1fc627fc72ec4'),
      payload: { syncIdentifier: 'carb-1' },
    });
  });

  it('omits what is unknown and skips empty or Nightscout-sourced entries', () => {
    const out = mapCarbs([carb({ note: undefined, absorptionHours: undefined }), carb({ id: 'c2', grams: 0 }), carb({ id: 'ns-carb-3' }), carb({ id: 'c4', note: '   ' })], ctx());
    expect(out).toHaveLength(2);
    expect(out[0]!.datum).toMatchObject({ nutrition: { carbohydrate: { net: 45.5, units: 'grams' } } });
    expect(out[0]!.datum).not.toHaveProperty('name');
    expect((out[0]!.datum as { nutrition: object }).nutrition).not.toHaveProperty('estimatedAbsorptionDuration');
    expect(out[1]!.datum).not.toHaveProperty('name');
  });
});

describe('boluses', () => {
  const bolus = (over: Partial<Extract<InsulinDose, { kind: 'bolus' | 'smb' }>> = {}): InsulinDose => ({ kind: 'bolus', id: 'bolus-1', date: T0, units: 2.35, ...over });
  const FORMULATION = { simple: { actingType: 'rapid' as const, brand: 'Fiasp' } };

  it('maps a manual bolus to bolus/normal with a pinned identity', () => {
    const [m] = mapDoses([bolus()], ctx());
    expect(m!.datum).toEqual({
      type: 'bolus',
      subType: 'normal',
      time: iso(T0),
      normal: 2.35,
      id: '1dac6f47ba514334c1de5ba974e6efff',
      origin: typedOrigin('bolus-1', 'bolus/normal'),
      payload: { syncIdentifier: 'bolus-1', duration: 0 },
    });
    expect(m!.datum.origin.id).toBe('d568360e5ea7998f1b001ec09410b826:bolus/normal');
  });

  it('maps an SMB to bolus/automated', () => {
    const [m] = mapDoses([bolus({ kind: 'smb', id: 'smb-1', units: 0.4 })], ctx({ insulinFormulation: FORMULATION, deviceIds: { pump: 'Dana_RS_1' } }));
    expect(m!.datum).toMatchObject({ type: 'bolus', subType: 'automated', normal: 0.4, insulinFormulation: FORMULATION, deviceId: 'Dana_RS_1' });
    expect(m!.datum.origin).toEqual(typedOrigin('smb-1', 'bolus/automated'));
  });

  it('maps insulin injected outside the pump to an insulin datum without a pump formulation', () => {
    const [m] = mapDoses([bolus({ id: 'pen-1', external: true, units: 4 })], ctx({ insulinFormulation: FORMULATION }));
    expect(m!.datum).toEqual({
      type: 'insulin',
      time: iso(T0),
      dose: { total: 4, units: 'Units' },
      id: idOf(resolvedTypedId('pen-1', 'insulin')),
      origin: typedOrigin('pen-1', 'insulin'),
      payload: { syncIdentifier: 'pen-1', duration: 0 },
    });
  });

  it('rounds units and skips empty, invalid and Nightscout-sourced doses', () => {
    const out = mapDoses([bolus({ units: 0.30000000000000004 }), bolus({ id: 'z', units: 0 }), bolus({ id: 'n', units: NaN }), bolus({ id: 'ns-bolus-1' })], ctx());
    expect(out.map((m) => (m.datum as { normal: number }).normal)).toEqual([0.3]);
  });

  it('selects the datum it produced for deletion', () => {
    const c = ctx();
    expect(doseSelectors(bolus(), c)).toEqual([{ origin: { id: resolvedTypedId('bolus-1', 'bolus/normal') } }]);
    expect(doseSelectors(bolus({ kind: 'smb', id: 's' }), c)).toEqual([{ origin: { id: resolvedTypedId('s', 'bolus/automated') } }]);
    expect(doseSelectors(bolus({ external: true, id: 'e' }), c)).toEqual([{ origin: { id: resolvedTypedId('e', 'insulin') } }]);
    for (const dose of [bolus(), bolus({ kind: 'smb', id: 's' }), bolus({ external: true, id: 'e' })]) {
      expect(doseSelectors(dose, c)[0]).toEqual({ origin: { id: mapDoses([dose], c)[0]!.datum.origin.id } });
    }
  });
});

describe('temp basals', () => {
  const temp = (over: Partial<Extract<InsulinDose, { kind: 'tempBasal' }>> = {}): InsulinDose => ({ kind: 'tempBasal', id: 'tb-1', date: T0, rate: 1.25, durationMin: 30, ...over });
  const scheduled = (date: number) => (date < T0 + HOUR ? 0.8 : 1.1);

  it('maps a loop temp basal to an automated basal with the profile rate suppressed', () => {
    const [m] = mapDoses([temp()], ctx({ scheduledBasalAt: scheduled }));
    expect(m!.revisedAt).toBe(T0);
    expect(m!.datum).toEqual({
      type: 'basal',
      deliveryType: 'automated',
      time: iso(T0),
      duration: 30 * MIN,
      rate: 1.25,
      scheduleName: 'Default',
      suppressed: { type: 'basal', deliveryType: 'scheduled', rate: 0.8, scheduleName: 'Default' },
      id: idOf(resolvedTypedId('tb-1', 'basal/automated')),
      origin: typedOrigin('tb-1', 'basal/automated'),
      payload: { syncIdentifier: 'tb-1', deliveredUnits: 0.625 },
    });
  });

  it('maps a hand-set temp basal to a temp basal', () => {
    const [m] = mapDoses([temp()], ctx({ isAutomaticTempBasal: () => false }));
    expect(m!.datum).toMatchObject({ type: 'basal', deliveryType: 'temp', rate: 1.25, duration: 30 * MIN });
    expect(m!.datum).not.toHaveProperty('scheduleName');
    expect(m!.datum).not.toHaveProperty('suppressed');
    expect(m!.datum.origin).toEqual(typedOrigin('tb-1', 'basal/temp'));
    expect(doseSelectors(temp(), ctx({ isAutomaticTempBasal: () => false }))).toEqual([{ origin: { id: resolvedTypedId('tb-1', 'basal/temp') } }]);
  });

  it('cuts a temp short when the next one starts, with the programmed length as expectedDuration', () => {
    const out = mapDoses([temp(), temp({ id: 'tb-2', date: T0 + 10 * MIN, rate: 0 })], ctx());
    const first = out.find((m) => m.datum.origin.id === resolvedTypedId('tb-1', 'basal/automated'))!;
    expect(first.datum).toMatchObject({ duration: 10 * MIN, expectedDuration: 30 * MIN, payload: { deliveredUnits: round3(1.25 / 6) } });
    expect(first.revisedAt).toBe(T0 + 10 * MIN);
    const second = out.find((m) => m.datum.origin.id === resolvedTypedId('tb-2', 'basal/automated'))!;
    expect(second.datum).toMatchObject({ rate: 0, duration: 30 * MIN });
    expect(second.datum).not.toHaveProperty('expectedDuration');
    expect(second.revisedAt).toBe(T0 + 10 * MIN);
  });

  it('treats a zero-duration temp as the cancel it is: it ends the previous one and has no datum', () => {
    const out = mapDoses([temp(), temp({ id: 'cancel', date: T0 + 5 * MIN, rate: 0, durationMin: 0 })], ctx());
    expect(out).toHaveLength(1);
    expect(out[0]!.datum).toMatchObject({ duration: 5 * MIN, expectedDuration: 30 * MIN });
  });

  it('does not shorten a temp that ends before the next starts', () => {
    const out = mapDoses([temp(), temp({ id: 'tb-2', date: T0 + 30 * MIN })], ctx());
    expect(out[0]!.datum).toMatchObject({ duration: 30 * MIN });
    expect(out[0]!.datum).not.toHaveProperty('expectedDuration');
    expect(out[0]!.revisedAt).toBe(T0);
  });

  it('is order independent', () => {
    const a = temp();
    const b = temp({ id: 'tb-2', date: T0 + 10 * MIN });
    expect(mapDoses([b, a], ctx()).map((m) => m.datum.id).sort()).toEqual(mapDoses([a, b], ctx()).map((m) => m.datum.id).sort());
  });

  it('skips negative or non-finite rates', () => {
    expect(mapDoses([temp({ rate: -1 }), temp({ id: 'n', rate: NaN })], ctx())).toHaveLength(0);
  });
});

const round3 = (v: number) => Math.round(v * 1000) / 1000;

describe('suspends', () => {
  const suspend = (over: Partial<Extract<InsulinDose, { kind: 'suspend' }>> = {}): InsulinDose => ({ kind: 'suspend', id: 'sus-1', date: T0, durationMin: 60, ...over });

  it('maps a timed suspend to a suspend basal plus suspended and resumed status events', () => {
    const out = mapDoses([suspend()], ctx({ scheduledBasalAt: () => 0.9 }));
    expect(out).toHaveLength(3);
    const [basal, suspended, resumed] = out;
    expect(basal!.datum).toEqual({
      type: 'basal',
      deliveryType: 'suspend',
      time: iso(T0),
      duration: 60 * MIN,
      suppressed: { type: 'basal', deliveryType: 'scheduled', rate: 0.9, scheduleName: 'Default' },
      id: idOf(resolvedTypedId('sus-1', 'basal/suspend')),
      origin: typedOrigin('sus-1', 'basal/suspend'),
      payload: { syncIdentifier: 'sus-1' },
    });
    expect(suspended!.datum).toMatchObject({ type: 'deviceEvent', subType: 'status', status: 'suspended', reason: { suspended: 'automatic' }, time: iso(T0) });
    expect(resumed!.datum).toMatchObject({ type: 'deviceEvent', subType: 'status', status: 'resumed', reason: { resumed: 'automatic' }, time: iso(T0 + HOUR) });
    expect(resumed!.revisedAt).toBe(T0 + HOUR);
    expect(suspended!.datum.origin).toEqual(typedOrigin('sus-1:suspended', 'deviceEvent/status'));
    expect(new Set(out.map((m) => m.datum.id)).size).toBe(3);
  });

  it('flags a suspend with no known end instead of inventing a duration', () => {
    const out = mapDoses([suspend({ durationMin: 0 })], ctx());
    expect(out).toHaveLength(2);
    expect(out[0]!.datum).toMatchObject({ deliveryType: 'suspend', duration: 0, annotations: [{ code: 'basal/unknown-duration' }] });
    expect(out[1]!.datum).toMatchObject({ status: 'suspended' });
  });

  it('ends an open suspend where the next basal event starts', () => {
    const out = mapDoses([suspend({ durationMin: 0 }), { kind: 'tempBasal', id: 'tb', date: T0 + 20 * MIN, rate: 1, durationMin: 30 }], ctx());
    const basal = out.find((m) => m.datum.type === 'basal' && m.datum.deliveryType === 'suspend')!;
    expect(basal.datum).toMatchObject({ duration: 20 * MIN });
    expect(basal.datum).not.toHaveProperty('annotations');
    expect(basal.revisedAt).toBe(T0 + 20 * MIN);
    expect(out.some((m) => m.datum.type === 'deviceEvent' && m.datum.subType === 'status' && m.datum.status === 'resumed' && m.datum.time === iso(T0 + 20 * MIN))).toBe(true);
  });

  it('honours a manual suspend reason', () => {
    const out = mapDoses([suspend()], ctx({ suspendReason: () => 'manual' }));
    expect(out[1]!.datum).toMatchObject({ reason: { suspended: 'manual' } });
    expect(out[2]!.datum).toMatchObject({ reason: { resumed: 'manual' } });
  });

  it('selects the suspend basal for deletion', () => {
    expect(doseSelectors(suspend(), ctx())).toEqual([{ origin: { id: resolvedTypedId('sus-1', 'basal/suspend') } }]);
  });
});

describe('scheduled basal', () => {
  it('maps a stretch of the programmed profile', () => {
    const [m] = mapScheduledBasal([{ id: 'sb-1', date: T0, durationMin: 90, rate: 0.8 }, { id: 'bad', date: T0, durationMin: 0, rate: 1 }], ctx({ insulinFormulation: { name: 'rapid' } }));
    expect(m!.datum).toEqual({
      type: 'basal',
      deliveryType: 'scheduled',
      time: iso(T0),
      duration: 90 * MIN,
      rate: 0.8,
      scheduleName: 'Default',
      insulinFormulation: { name: 'rapid' },
      id: idOf(resolvedTypedId('sb-1', 'basal/scheduled')),
      origin: typedOrigin('sb-1', 'basal/scheduled'),
      payload: { syncIdentifier: 'sb-1', deliveredUnits: 1.2 },
    });
  });
});

describe('device events', () => {
  const events: TidepoolDeviceEvent[] = [
    { kind: 'reservoirChange', id: 'r1', date: T0 },
    { kind: 'prime', id: 'p1', date: T0 + MIN, target: 'cannula', volume: 0.5 },
    { kind: 'prime', id: 'p2', date: T0 + 2 * MIN },
    { kind: 'alarm', id: 'a1', date: T0 + 3 * MIN, alarm: 'occlusion' },
    { kind: 'alarm', id: 'a2', date: T0 + 4 * MIN, alarm: 'other', detail: 'Pump error 7' },
    { kind: 'status', id: 's1', date: T0 + 5 * MIN, name: 'resumed', reason: 'manual' },
    { kind: 'timeChange', id: 't1', date: T0 + 6 * MIN, fromOffsetMinutes: 60, toOffsetMinutes: 120, method: 'automatic' },
  ];

  it('maps each event kind', () => {
    const out = mapDeviceEvents(events, ctx({ deviceIds: { pump: 'Pump_1' } })).map((m) => m.datum);
    expect(out[0]).toEqual({ type: 'deviceEvent', subType: 'reservoirChange', time: iso(T0), id: idOf(resolvedTypedId('r1', 'deviceEvent/reservoirChange')), origin: typedOrigin('r1', 'deviceEvent/reservoirChange'), payload: { syncIdentifier: 'r1' }, deviceId: 'Pump_1' });
    expect(out[1]).toMatchObject({ subType: 'prime', primeTarget: 'cannula', volume: 0.5 });
    expect(out[2]).toMatchObject({ subType: 'prime', primeTarget: 'tubing' });
    expect(out[2]).not.toHaveProperty('volume');
    expect(out[3]).toMatchObject({ subType: 'alarm', alarmType: 'occlusion' });
    expect(out[4]).toMatchObject({ subType: 'alarm', alarmType: 'other', payload: { syncIdentifier: 'a2', otherAlarmType: 'Pump error 7' } });
    expect(out[5]).toMatchObject({ subType: 'status', status: 'resumed', reason: { resumed: 'manual' } });
    expect(out[6]).toMatchObject({ subType: 'timeChange', from: { time: '2026-11-25T13:06:00' }, to: { time: '2026-11-25T14:06:00' }, method: 'automatic' });
  });

  it('maps every alarm kind to Tidepool snake_case', () => {
    const kinds = ['autoOff', 'lowInsulin', 'lowPower', 'noDelivery', 'noInsulin', 'noPower', 'occlusion', 'overLimit', 'other'] as const;
    const out = mapDeviceEvents(kinds.map((alarm, i) => ({ kind: 'alarm' as const, id: `a${i}`, date: T0 + i, alarm })), ctx());
    expect(out.map((m) => (m.datum as { alarmType: string }).alarmType)).toEqual(['auto_off', 'low_insulin', 'low_power', 'no_delivery', 'no_insulin', 'no_power', 'occlusion', 'over_limit', 'other']);
  });
});

describe('pump settings', () => {
  const profile: TherapyProfile = {
    basal: [{ startMinute: 0, value: 0.8 }, { startMinute: 360, value: 1.05 }],
    isf: [{ startMinute: 0, value: 45 }],
    carbRatio: [{ startMinute: 0, value: 10 }, { startMinute: 720, value: 12 }],
    target: [{ startMinute: 0, value: { low: 100, high: 110 } }],
    diaHours: 6,
    insulinCurve: 'ultra-rapid',
    utcOffsetMinutes: 60,
  };
  const snapshot = (over: Partial<PumpSettingsSnapshot> = {}): PumpSettingsSnapshot => ({
    date: T0,
    profile,
    limits: { maxBasalRate: 3, maxBolus: 10, suspendThreshold: 70 },
    glucoseUnit: 'mmol/L',
    timeZone: 'Europe/Berlin',
    pump: { manufacturer: 'Dana', model: 'RS', name: 'Pump 1', firmwareVersion: '3.0' },
    ...over,
  });

  it('maps the therapy profile and limits to pumpSettings', () => {
    const m = mapPumpSettings(snapshot(), ctx({ insulinFormulation: { simple: { actingType: 'rapid', brand: 'Fiasp' } } }));
    const d = m.datum;
    expect(d).toMatchObject({
      type: 'pumpSettings',
      time: iso(T0),
      timezone: 'Europe/Berlin',
      timezoneOffset: 60,
      activeSchedule: 'Default',
      basal: { rateMaximum: { value: 3, units: 'Units/hour' } },
      basalSchedules: { Default: [{ start: 0, rate: 0.8 }, { start: 21_600_000, rate: 1.05 }] },
      bgSafetyLimit: 70,
      bgTargets: { Default: [{ start: 0, low: 100, high: 110 }] },
      bolus: { amountMaximum: { value: 10, units: 'Units' } },
      carbRatios: { Default: [{ start: 0, amount: 10 }, { start: 43_200_000, amount: 12 }] },
      display: { bloodGlucose: { units: 'mmol/L' } },
      insulinFormulation: { simple: { actingType: 'rapid', brand: 'Fiasp' } },
      insulinModel: { modelType: 'fiasp', actionDelay: 600, actionDuration: 21_600, actionPeakOffset: 3300 },
      insulinSensitivities: { Default: [{ start: 0, amount: 45 }] },
      units: { bg: 'mg/dL', carb: 'grams', insulin: 'Units' },
      manufacturers: ['Dana'],
      model: 'RS',
      name: 'Pump 1',
      firmwareVersion: '3.0',
    });
    expect(d.origin.id).toBe(resolvedTypedId(m.contentKey, 'pumpSettings'));
    expect(d.id).toBe(idOf(d.origin.id));
    expect(d.payload).toEqual({ syncIdentifier: m.contentKey });
  });

  it('uses the rapid-adult model, the custom peak and no pump fields when unknown', () => {
    const d = mapPumpSettings(snapshot({ profile: { ...profile, insulinCurve: 'rapid-acting', insulinPeakMinutes: 90, diaHours: 5 }, pump: undefined, timeZone: undefined, limits: { maxBasalRate: 2, maxBolus: 8, suspendThreshold: NaN } }), ctx()).datum;
    expect(d.insulinModel).toEqual({ modelType: 'rapidAdult', actionDelay: 600, actionDuration: 18_000, actionPeakOffset: 5400 });
    expect(d).not.toHaveProperty('manufacturers');
    expect(d).not.toHaveProperty('timezone');
    expect(d).not.toHaveProperty('bgSafetyLimit');
  });

  it('has a content key that ignores the time but follows every setting', () => {
    const base = mapPumpSettings(snapshot(), ctx());
    expect(mapPumpSettings(snapshot({ date: T0 + HOUR }), ctx()).contentKey).toBe(base.contentKey);
    expect(mapPumpSettings(snapshot({ limits: { maxBasalRate: 3.5, maxBolus: 10, suspendThreshold: 70 } }), ctx()).contentKey).not.toBe(base.contentKey);
    expect(mapPumpSettings(snapshot({ profile: { ...profile, diaHours: 7 } }), ctx()).contentKey).not.toBe(base.contentKey);
  });
});
