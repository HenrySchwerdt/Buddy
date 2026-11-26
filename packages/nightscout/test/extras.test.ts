import { describe, expect, it } from 'vitest';
import { silentLogger, type TherapyProfile } from '@buddy/core';
import {
  asMmolL,
  createNightscoutUploader,
  mapLoopRunToDeviceStatus,
  mapNoteToTreatment,
  mapProfileToStore,
  mapSensorStartsToTreatments,
} from '../src';
import { iso, MIN, PUMP, RUN, T0 } from './fixtures';

const PROFILE: TherapyProfile = {
  basal: [
    { startMinute: 0, value: 0.8 },
    { startMinute: 390, value: 1.05 },
  ],
  isf: [
    { startMinute: 0, value: 50 },
    { startMinute: 720, value: 45 },
  ],
  carbRatio: [{ startMinute: 0, value: 10 }],
  target: [{ startMinute: 0, value: { low: 100, high: 110 } }],
  diaHours: 6,
  insulinCurve: 'rapid-acting',
};

const base = { profile: PROFILE, units: 'mg/dL' as const, timezone: 'Europe/Berlin', now: T0 + 123 };

describe('mapProfileToStore (Trio uploadProfiles)', () => {
  it('builds the default profile like Trio', () => {
    const doc = mapProfileToStore(base);
    expect(doc).toMatchObject({
      defaultProfile: 'default',
      startDate: iso(T0 + 123),
      mills: T0,
      units: 'mg/dl',
      enteredBy: 'Buddy',
      bundleIdentifier: '',
      deviceToken: '',
      isAPNSProduction: false,
      teamID: '',
      remoteCommands: [],
      overridePresets: [],
    });
    expect(doc.store.default).toEqual({
      dia: 6,
      // 8 * 12 / 50 * 10 = 19.2 -> truncated like Swift's Int()
      carbs_hr: 19,
      delay: 0,
      timezone: 'Europe/Berlin',
      target_low: [{ time: '00:00', value: 100, timeAsSeconds: 0 }],
      target_high: [{ time: '00:00', value: 110, timeAsSeconds: 0 }],
      sens: [
        { time: '00:00', value: 50, timeAsSeconds: 0 },
        { time: '12:00', value: 45, timeAsSeconds: 43200 },
      ],
      basal: [
        { time: '00:00', value: 0.8, timeAsSeconds: 0 },
        { time: '06:30', value: 1.05, timeAsSeconds: 23400 },
      ],
      carbratio: [{ time: '00:00', value: 10, timeAsSeconds: 0 }],
      units: 'mg/dl',
    });
  });

  it('converts glucose values (not basal/CR) to mmol with Trio rounding', () => {
    const doc = mapProfileToStore({ ...base, units: 'mmol/L' });
    expect(doc.units).toBe('mmol');
    expect(doc.store.default!.units).toBe('mmol');
    expect(doc.store.default!.sens.map((r) => r.value)).toEqual([2.8, 2.5]);
    expect(doc.store.default!.target_low[0]!.value).toBe(5.6);
    expect(doc.store.default!.basal[1]!.value).toBe(1.05);
    expect(asMmolL(180)).toBe(10);
  });

  it('includes override presets, omitting zero/indefinite fields, and remote fields when given', () => {
    const preset = { id: 'a', name: 'Run', percentage: 70, target: 140, scaleIsf: true, scaleCr: true, disableSmb: false, durationMin: 60 };
    const doc = mapProfileToStore({
      ...base,
      overridePresets: [preset, { ...preset, id: 'b', name: 'Sick', durationMin: null, target: null }],
      expirationDate: T0,
      remoteCommands: ['bolus'],
      teamID: 'T',
    });
    expect(doc.overridePresets).toEqual([
      { name: 'Run', duration: 60, percentage: 70, target: 140 },
      { name: 'Sick', percentage: 70 },
    ]);
    expect(doc.expirationDate).toBe(iso(T0));
    expect(doc.remoteCommands).toEqual(['bolus']);
  });

  it('yields carbs_hr 0 for an unusable ISF', () => {
    expect(mapProfileToStore({ ...base, profile: { ...PROFILE, isf: [{ startMinute: 0, value: 0 }] } }).store.default!.carbs_hr).toBe(0);
  });
});

describe('sensor and note treatments', () => {
  it('maps a sensor start like Trio createCGMStateTreatment', () => {
    const [doc] = mapSensorStartsToTreatments([{ startedAt: T0, transmitterId: '8GABCD', activatedAt: Date.UTC(2026, 10, 25, 11, 30, 5) }]);
    expect(doc).toEqual({
      eventType: 'Sensor Start',
      created_at: iso(T0),
      enteredBy: 'Buddy',
      identifier: `sensor-${T0}`,
      id: `sensor-${T0}`,
      notes: '8GABCD activated on 2026-11-25 11:30:05 +0000',
    });
  });

  it('drops session starts within a minute of the previous one', () => {
    const docs = mapSensorStartsToTreatments([{ startedAt: T0 + 30_000 }, { startedAt: T0 }, { startedAt: T0 + 10 * MIN }]);
    expect(docs.map((d) => d.created_at)).toEqual([iso(T0), iso(T0 + 10 * MIN)]);
  });

  it('maps a note', () => {
    expect(mapNoteToTreatment('Pod changed', T0)).toMatchObject({ eventType: 'Note', notes: 'Pod changed', created_at: iso(T0), enteredBy: 'Buddy' });
  });
});

describe('device status batteries', () => {
  it('adds pump battery string/voltage and uploader voltage', () => {
    const s = mapLoopRunToDeviceStatus(RUN, PUMP, { uploaderBattery: 50, uploaderBatteryVoltage: 3.8, pumpBatteryVoltage: 1.52 });
    expect(s.pump?.battery).toEqual({ percent: 70, voltage: 1.52, string: 'normal' });
    expect(s.uploader).toEqual({ battery: 50, batteryVoltage: 3.8 });
  });
  it('flags a low pump battery', () => {
    expect(mapLoopRunToDeviceStatus(RUN, { ...PUMP, batteryPercent: 15 }).pump?.battery?.string).toBe('low');
  });
});

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
}
function recorder(status = 200) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('{}', { status });
  }) as typeof fetch;
  return { fn, calls };
}
const uploaderOf = (r: ReturnType<typeof recorder>, url = 'https://ns.example.com/') =>
  createNightscoutUploader({ url, token: 'tok', fetch: r.fn, clock: { now: () => T0 }, log: silentLogger });

describe('uploader one-off requests', () => {
  it('POSTs the profile store as a single document to profile.json', async () => {
    const r = recorder();
    const res = await uploaderOf(r).uploadProfile(base);
    expect(res).toEqual({ ok: true, skipped: false });
    expect(r.calls[0]).toMatchObject({ method: 'POST' });
    expect(r.calls[0]!.url.pathname).toBe('/api/v1/profile.json');
    expect(r.calls[0]!.url.searchParams.get('token')).toBe('tok');
    expect(Array.isArray(r.calls[0]!.body)).toBe(false);
    expect((r.calls[0]!.body as { defaultProfile: string }).defaultProfile).toBe('default');
  });

  it('uploads a note at the current time', async () => {
    const r = recorder();
    await uploaderOf(r).uploadNote('Sensor warmup');
    expect(r.calls[0]!.url.pathname).toBe('/api/v1/treatments.json');
    expect(r.calls[0]!.body).toEqual([expect.objectContaining({ eventType: 'Note', notes: 'Sensor warmup', created_at: iso(T0) })]);
  });

  it('deletes treatments by id', async () => {
    const r = recorder();
    expect(await uploaderOf(r).deleteTreatment('carb-1')).toEqual({ ok: true, skipped: false });
    expect(r.calls[0]!.method).toBe('DELETE');
    expect(r.calls[0]!.url.pathname).toBe('/api/v1/treatments.json');
    expect(r.calls[0]!.url.searchParams.get('find[id][$eq]')).toBe('carb-1');
  });

  it('deletes glucose by id or timestamp', async () => {
    const r = recorder();
    await uploaderOf(r).deleteGlucose('g1', T0);
    const u = r.calls[0]!.url;
    expect(r.calls[0]!.method).toBe('DELETE');
    expect(u.pathname).toBe('/api/v1/entries.json');
    expect(u.searchParams.get('find[$or][0][id][$eq]')).toBe('g1');
    expect(u.searchParams.get('find[$or][2][dateString][$eq]')).toBe(iso(T0));
  });

  it('reports failures instead of throwing and skips without a URL', async () => {
    const r = recorder(500);
    expect(await uploaderOf(r).deleteTreatment('x')).toEqual({ ok: false, error: 'Nightscout treatment deletion failed: HTTP 500' });
    const none = recorder();
    expect(await uploaderOf(none, '').uploadNote('n')).toEqual({ ok: true, skipped: true });
    expect(none.calls).toHaveLength(0);
    expect((await uploaderOf(none, 'http://insecure.example.com').uploadProfile(base)).ok).toBe(false);
    const boom = createNightscoutUploader({ url: 'https://ns.example.com', fetch: (async () => { throw new Error('offline'); }) as typeof fetch, clock: { now: () => T0 }, log: silentLogger });
    expect(await boom.deleteGlucose('a', T0)).toMatchObject({ ok: false });
  });
});
