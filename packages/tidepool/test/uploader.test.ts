import type { GlucoseReading, InsulinDose, TherapyProfile } from '@buddy/core';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  MAX_BATCH,
  TidepoolError,
  createTidepoolApi,
  createTidepoolAuth,
  createTidepoolUploader,
  resolvedTypedId,
  type PumpSettingsSnapshot,
  type TidepoolApi,
  type TidepoolAuth,
  type TidepoolDataSet,
  type TidepoolDataSetRequest,
  type TidepoolDatum,
  type TidepoolSelector,
  type TidepoolSession,
  type TidepoolUploadSnapshot,
} from '../src';
import { CLIENT_ID, CLIENT_NAME, CLIENT_VERSION, MIN, REDIRECT_URI, T0, USER_ID, fixedClock, json, memorySecrets, recordingLogger, tidepoolServer, callBody, parseQueryState } from './fixtures';

const session = (userId = USER_ID): TidepoolSession => ({
  environment: { host: 'app.tidepool.org', port: 443 },
  accessToken: 'tok',
  accessTokenExpiresAt: null,
  refreshToken: 'ref',
  userId,
  username: 'pat',
  userRoles: [],
  createdAt: T0,
  traceId: 't',
});

class FakeAuth {
  current: TidepoolSession | null = session();
  readonly auth = { getSession: async () => this.current } as unknown as TidepoolAuth;
}

interface Sent {
  readonly dataSetId: string;
  readonly data: readonly TidepoolDatum[];
}

class FakeApi implements TidepoolApi {
  dataSets: TidepoolDataSet[] = [];
  created: TidepoolDataSetRequest[] = [];
  listCalls = 0;
  sent: Sent[] = [];
  deleted: { dataSetId: string; selectors: readonly TidepoolSelector[] }[] = [];
  /** Throw this on the n-th createData call (1-based) */
  failOn = new Map<number, Error>();
  deleteError: Error | null = null;
  private createCalls = 0;

  async listDataSets(): Promise<TidepoolDataSet[]> {
    this.listCalls++;
    return this.dataSets;
  }
  async createDataSet(request: TidepoolDataSetRequest): Promise<TidepoolDataSet> {
    this.created.push(request);
    return { id: 'ds-new', uploadId: 'ds-new' };
  }
  async createData(dataSetId: string, data: readonly TidepoolDatum[]): Promise<void> {
    const n = ++this.createCalls;
    const err = this.failOn.get(n);
    if (err) throw err;
    this.sent.push({ dataSetId, data });
  }
  async deleteData(dataSetId: string, selectors: readonly TidepoolSelector[]): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push({ dataSetId, selectors });
  }
  get datums(): TidepoolDatum[] {
    return this.sent.flatMap((s) => [...s.data]);
  }
}

function setup(initialState = {}) {
  const api = new FakeApi();
  const fake = new FakeAuth();
  const clock = fixedClock(T0 + 60 * MIN);
  const log = recordingLogger();
  const uploader = createTidepoolUploader({ api, auth: fake.auth, clientName: CLIENT_NAME, clientVersion: CLIENT_VERSION, clock, log, initialState });
  return { api, fake, clock, log, uploader };
}

const reading = (i: number): GlucoseReading => ({ date: T0 + i * 5 * MIN, value: 100 + (i % 50), source: 'cgm', trend: 'flat' });
const snapshot = (over: Partial<TidepoolUploadSnapshot> = {}): TidepoolUploadSnapshot => ({ glucose: [], doses: [], carbs: [], ...over });
const types = (api: FakeApi) => api.datums.map((d) => d.type);

describe('data set', () => {
  it('creates a continuous data set once and reuses it', async () => {
    const { api, uploader } = setup();
    await uploader.upload(snapshot({ glucose: [reading(0)] }));
    await uploader.upload(snapshot({ glucose: [reading(0), reading(1)] }));
    expect(api.created).toEqual([
      {
        type: 'upload',
        dataSetType: 'continuous',
        client: { name: CLIENT_NAME, version: CLIENT_VERSION },
        deduplicator: { name: 'org.tidepool.deduplicator.dataset.delete.origin' },
        deviceTags: ['bgm', 'cgm', 'insulin-pump'],
      },
    ]);
    expect(api.listCalls).toBe(1);
    expect(api.sent.map((s) => s.dataSetId)).toEqual(['ds-new', 'ds-new']);
    expect(uploader.getState().dataSetId).toBe('ds-new');
  });

  it('uses an existing data set of this client, preferring uploadId', async () => {
    const { api, uploader, log } = setup();
    api.dataSets = [{ id: 'ds-a', uploadId: 'up-a' }, { id: 'ds-b' }];
    await uploader.upload(snapshot({ glucose: [reading(0)] }));
    expect(api.created).toHaveLength(0);
    expect(api.sent[0]!.dataSetId).toBe('up-a');
    expect(log.lines.join('\n')).toMatch(/several matching data sets/);
  });

  it('does not touch the network when there is nothing new', async () => {
    const { api, uploader } = setup();
    const r = await uploader.upload(snapshot());
    expect(r).toMatchObject({ skipped: false, reauthRequired: false });
    expect(api.listCalls).toBe(0);
  });

  it('forgets a data set the server no longer knows', async () => {
    const { api, uploader } = setup({ dataSetId: 'gone' });
    api.failOn.set(1, new TidepoolError('not-found', 'nope', 404));
    const r = await uploader.upload(snapshot({ glucose: [reading(0)] }));
    expect(r.collections.glucose.ok).toBe(false);
    expect(uploader.getState().dataSetId).toBeNull();
    const again = await uploader.upload(snapshot({ glucose: [reading(0)] }));
    expect(again.collections.glucose).toEqual({ ok: true, uploaded: 1 });
    expect(api.sent[0]!.dataSetId).toBe('ds-new');
  });
});

describe('high-water marks and batching', () => {
  it('sends only what is newer than the mark and advances it', async () => {
    const { api, uploader } = setup();
    const first = await uploader.upload(snapshot({ glucose: [reading(0), reading(1)] }));
    expect(first.collections.glucose).toEqual({ ok: true, uploaded: 2 });
    expect(uploader.getState().marks.glucose).toBe(reading(1).date);
    const second = await uploader.upload(snapshot({ glucose: [reading(0), reading(1), reading(2)] }));
    expect(second.collections.glucose).toEqual({ ok: true, uploaded: 1 });
    expect(api.datums.map((d) => d.time)).toEqual([reading(0), reading(1), reading(2)].map((r) => new Date(r.date).toISOString()));
  });

  it('does not send the future, and picks it up once it is due', async () => {
    const { api, uploader, clock } = setup();
    await uploader.upload(snapshot({ glucose: [{ ...reading(0), date: clock.now() + 10 * MIN }] }));
    expect(api.sent).toHaveLength(0);
    clock.advance(11 * MIN);
    const r = await uploader.upload(snapshot({ glucose: [{ ...reading(0), date: T0 + 70 * MIN }] }));
    expect(r.collections.glucose).toMatchObject({ uploaded: 1 });
  });

  it('splits into the declared batch size, oldest first', async () => {
    const { api, uploader, clock } = setup();
    clock.set(T0 + 365 * 24 * 60 * MIN);
    const readings = Array.from({ length: MAX_BATCH.glucose * 2 + 5 }, (_, i) => reading(i)).reverse();
    const r = await uploader.upload(snapshot({ glucose: readings }));
    expect(r.collections.glucose).toEqual({ ok: true, uploaded: readings.length });
    expect(api.sent.map((s) => s.data.length)).toEqual([1000, 1000, 5]);
    const times = api.datums.map((d) => Date.parse(d.time));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('resumes after a failed batch without losing or repeating anything', async () => {
    const { api, uploader, clock } = setup();
    clock.set(T0 + 365 * 24 * 60 * MIN);
    const readings = Array.from({ length: MAX_BATCH.glucose + 10 }, (_, i) => reading(i));
    api.failOn.set(2, new TidepoolError('network', 'offline'));
    const failed = await uploader.upload(snapshot({ glucose: readings }));
    expect(failed.collections.glucose).toMatchObject({ ok: false, uploaded: 1000 });
    expect(uploader.getState().marks.glucose).toBe(readings[999]!.date);
    const retry = await uploader.upload(snapshot({ glucose: readings }));
    expect(retry.collections.glucose).toEqual({ ok: true, uploaded: 10 });
    expect(api.datums).toHaveLength(readings.length);
    expect(new Set(api.datums.map((d) => d.id)).size).toBe(readings.length);
  });

  it('keeps a same-millisecond neighbour across a batch boundary', async () => {
    const { api, uploader, clock } = setup();
    clock.set(T0 + 365 * 24 * 60 * MIN);
    const n = MAX_BATCH.glucose;
    const readings = [...Array.from({ length: n - 1 }, (_, i) => reading(i)), { ...reading(n), source: 'a' }, { ...reading(n), source: 'b' }];
    // Make the last two share the exact same date (different sources, so different ids).
    const last = reading(n).date;
    const aligned = readings.map((r, i) => (i >= n - 1 ? { ...r, date: last } : r));
    api.failOn.set(2, new TidepoolError('network', 'offline'));
    await uploader.upload(snapshot({ glucose: aligned }));
    expect(uploader.getState().marks.glucose).toBe(last - 1);
    await uploader.upload(snapshot({ glucose: aligned }));
    expect(new Set(api.datums.map((d) => d.id)).size).toBe(n + 1);
  });

  it('reports failures per collection and keeps going with the others', async () => {
    const { api, uploader } = setup();
    api.failOn.set(1, new TidepoolError('malformed', 'bad value', 400));
    const r = await uploader.upload(snapshot({ glucose: [reading(0)], carbs: [{ id: 'c1', date: T0, grams: 20 }] }));
    expect(r.collections.glucose).toMatchObject({ ok: false, uploaded: 0, error: expect.stringContaining('bad value') });
    expect(r.collections.carbs).toEqual({ ok: true, uploaded: 1 });
    expect(r.reauthRequired).toBe(false);
    expect(uploader.getState().marks).toMatchObject({ glucose: 0, carbs: T0 });
  });

  it('flags a lost login and stops hammering', async () => {
    const { api, uploader } = setup();
    api.failOn.set(1, new TidepoolError('not-authenticated', 'expired', 401));
    const r = await uploader.upload(snapshot({ glucose: [reading(0)], carbs: [{ id: 'c1', date: T0, grams: 20 }] }));
    expect(r.reauthRequired).toBe(true);
    expect(api.sent).toHaveLength(0);
    expect(r.collections.carbs).toEqual({ ok: true, uploaded: 0 });
  });

  it('shares a running upload between concurrent callers', async () => {
    const { api, uploader } = setup();
    const snap = snapshot({ glucose: [reading(0)] });
    const [a, b] = await Promise.all([uploader.upload(snap), uploader.upload(snap)]);
    expect(a).toBe(b);
    expect(api.sent).toHaveLength(1);
  });
});

describe('what is uploaded', () => {
  const doses: InsulinDose[] = [
    { kind: 'bolus', id: 'b1', date: T0, units: 3 },
    { kind: 'smb', id: 's1', date: T0 + 5 * MIN, units: 0.3 },
    { kind: 'tempBasal', id: 't1', date: T0 + 5 * MIN, rate: 1.5, durationMin: 30 },
  ];

  it('uploads every collection with the account\'s ids', async () => {
    const { api, uploader } = setup();
    const r = await uploader.upload(
      snapshot({
        glucose: [reading(0)],
        doses,
        carbs: [{ id: 'c1', date: T0, grams: 30 }],
        deviceEvents: [{ kind: 'reservoirChange', id: 'rc1', date: T0 }],
        scheduledBasal: [{ id: 'sb1', date: T0 - 30 * MIN, durationMin: 30, rate: 0.8 }],
      }),
    );
    expect(r.collections).toEqual({
      glucose: { ok: true, uploaded: 1 },
      doses: { ok: true, uploaded: 4 },
      carbs: { ok: true, uploaded: 1 },
      deviceEvents: { ok: true, uploaded: 1 },
      settings: { ok: true, uploaded: 0 },
    });
    expect(types(api).sort()).toEqual(['basal', 'basal', 'bolus', 'bolus', 'cbg', 'deviceEvent', 'food']);
    expect(api.datums.find((d) => d.type === 'bolus')!.origin.id).toBe(resolvedTypedId('b1', 'bolus/normal'));
  });

  it('re-sends a temp basal that a later one cut short, with the same id', async () => {
    const { api, uploader, clock } = setup();
    const t1: InsulinDose = { kind: 'tempBasal', id: 't1', date: T0, rate: 1, durationMin: 30 };
    await uploader.upload(snapshot({ doses: [t1] }));
    expect(api.datums[0]).toMatchObject({ duration: 30 * MIN });
    clock.advance(10 * MIN);
    const t2: InsulinDose = { kind: 'tempBasal', id: 't2', date: T0 + 10 * MIN, rate: 2, durationMin: 30 };
    const r = await uploader.upload(snapshot({ doses: [t1, t2] }));
    expect(r.collections.doses).toEqual({ ok: true, uploaded: 2 });
    const resent = api.datums.filter((d) => d.origin.id === resolvedTypedId('t1', 'basal/automated'));
    expect(resent).toHaveLength(2);
    expect(resent[1]).toMatchObject({ duration: 10 * MIN, expectedDuration: 30 * MIN });
    expect(resent[1]!.id).toBe(resent[0]!.id);
  });

  it('skips data that came from Nightscout', async () => {
    const { api, uploader } = setup();
    await uploader.upload(
      snapshot({ glucose: [{ ...reading(0), source: 'nightscout' }], doses: [{ kind: 'bolus', id: 'ns-bolus-1', date: T0, units: 1 }], carbs: [{ id: 'ns-carb-1', date: T0, grams: 10 }] }),
    );
    expect(api.sent).toHaveLength(0);
  });
});

describe('pump settings', () => {
  const profile: TherapyProfile = {
    basal: [{ startMinute: 0, value: 1 }],
    isf: [{ startMinute: 0, value: 50 }],
    carbRatio: [{ startMinute: 0, value: 10 }],
    target: [{ startMinute: 0, value: { low: 100, high: 110 } }],
    diaHours: 6,
    insulinCurve: 'rapid-acting',
  };
  const settings = (over: Partial<PumpSettingsSnapshot> = {}): PumpSettingsSnapshot => ({ date: T0, profile, limits: { maxBasalRate: 3, maxBolus: 10, suspendThreshold: 70 }, glucoseUnit: 'mg/dL', ...over });

  it('uploads when the content changes, not when only the time does', async () => {
    const { api, uploader } = setup();
    const first = await uploader.upload(snapshot({ settings: settings() }));
    expect(first.collections.settings).toEqual({ ok: true, uploaded: 1 });
    const same = await uploader.upload(snapshot({ settings: settings({ date: T0 + 5 * MIN }) }));
    expect(same.collections.settings).toEqual({ ok: true, uploaded: 0 });
    const changed = await uploader.upload(snapshot({ settings: settings({ limits: { maxBasalRate: 2, maxBolus: 10, suspendThreshold: 70 } }) }));
    expect(changed.collections.settings).toEqual({ ok: true, uploaded: 1 });
    expect(types(api)).toEqual(['pumpSettings', 'pumpSettings']);
  });

  it('retries settings after a failure', async () => {
    const { api, uploader } = setup();
    api.failOn.set(1, new TidepoolError('network', 'offline'));
    const failed = await uploader.upload(snapshot({ settings: settings() }));
    expect(failed.collections.settings.ok).toBe(false);
    expect(uploader.getState().settingsKey).toBeNull();
    const retry = await uploader.upload(snapshot({ settings: settings() }));
    expect(retry.collections.settings).toEqual({ ok: true, uploaded: 1 });
  });
});

describe('accounts and state', () => {
  it('does nothing while signed out', async () => {
    const { api, fake, uploader } = setup();
    fake.current = null;
    expect(await uploader.upload(snapshot({ glucose: [reading(0)] }))).toMatchObject({ skipped: true, reason: 'signed-out' });
    expect(api.listCalls).toBe(0);
  });

  it('starts over for a different account', async () => {
    const { api, fake, uploader } = setup();
    await uploader.upload(snapshot({ glucose: [reading(0)] }));
    fake.current = session('someone-else');
    api.dataSets = [{ uploadId: 'ds-other' }];
    const r = await uploader.upload(snapshot({ glucose: [reading(0)] }));
    expect(r.collections.glucose).toEqual({ ok: true, uploaded: 1 });
    expect(api.sent.at(-1)!.dataSetId).toBe('ds-other');
    expect(uploader.getState().userId).toBe('someone-else');
  });

  it('restores persisted state and sanitizes junk', async () => {
    const first = setup();
    await first.uploader.upload(snapshot({ glucose: [reading(0)] }));
    const saved = JSON.parse(JSON.stringify(first.uploader.getState()));
    const second = setup(saved);
    const r = await second.uploader.upload(snapshot({ glucose: [reading(0)] }));
    expect(r.collections.glucose).toEqual({ ok: true, uploaded: 0 });
    expect(second.api.listCalls).toBe(0);

    const junk = setup({ userId: 5, dataSetId: {}, marks: { glucose: -1, doses: 'x', carbs: NaN }, settingsKey: 1 } as never);
    expect(junk.uploader.getState()).toEqual(EMPTY_STATE);
  });
});

describe('delete', () => {
  it('deletes by origin id for doses, carbs and glucose', async () => {
    const { api, uploader } = setup({ dataSetId: 'ds-1', userId: USER_ID });
    const r = await uploader.delete({
      doses: [{ kind: 'bolus', id: 'b1', date: T0, units: 1 }, { kind: 'suspend', id: 's1', date: T0, durationMin: 10 }],
      carbs: [{ id: 'c1' }],
      glucose: [reading(0)],
    });
    expect(r).toEqual({ ok: true, deleted: 4 });
    expect(api.deleted).toHaveLength(1);
    expect(api.deleted[0]!.dataSetId).toBe('ds-1');
    expect(api.deleted[0]!.selectors[0]).toEqual({ origin: { id: resolvedTypedId('b1', 'bolus/normal') } });
    expect(api.deleted[0]!.selectors[1]).toEqual({ origin: { id: resolvedTypedId('s1', 'basal/suspend') } });
  });

  it('matches what was uploaded', async () => {
    const { api, uploader } = setup();
    const carb = { id: 'c1', date: T0, grams: 20 };
    await uploader.upload(snapshot({ carbs: [carb], glucose: [reading(0)] }));
    await uploader.delete({ carbs: [carb], glucose: [reading(0)] });
    const uploadedOrigins = api.datums.map((d) => d.origin.id).sort();
    expect(api.deleted[0]!.selectors.map((s) => ('origin' in s ? s.origin.id : '')).sort()).toEqual(uploadedOrigins);
  });

  it('treats "not found" as deleted and reports other failures', async () => {
    const { api, uploader } = setup({ dataSetId: 'ds-1', userId: USER_ID });
    api.deleteError = new TidepoolError('not-found', 'x', 404);
    expect(await uploader.delete({ carbs: [{ id: 'c1' }] })).toEqual({ ok: true, deleted: 1 });
    api.deleteError = new TidepoolError('not-authenticated', 'x', 401);
    expect(await uploader.delete({ carbs: [{ id: 'c1' }] })).toMatchObject({ ok: false, reauthRequired: true });
  });

  it('does nothing for nothing', async () => {
    const { api, uploader } = setup();
    expect(await uploader.delete({})).toEqual({ ok: true, deleted: 0 });
    expect(api.listCalls).toBe(0);
  });
});

describe('end to end over HTTP', () => {
  it('signs in, creates the data set and uploads through the real client', async () => {
    const server = tidepoolServer({
      'GET https://app.tidepool.org/v1/users/user-1234/data_sets': () => json(200, []),
      'POST https://app.tidepool.org/v1/users/user-1234/data_sets': () => json(201, { data: { id: 'ds-e2e', uploadId: 'ds-e2e' } }),
      'POST https://app.tidepool.org/v1/data_sets/ds-e2e/data': () => json(200, { data: {} }),
    });
    const clock = fixedClock(T0 + 60 * MIN);
    const auth = createTidepoolAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      fetch: server.fetch,
      secrets: memorySecrets(),
      clock,
      random: () => new Uint8Array(32).fill(1),
      openAuthSession: async (url, redirectUri) => `${redirectUri}?code=c&state=${parseQueryState(url)}`,
    });
    await auth.login();
    const api = createTidepoolApi({ auth, fetch: server.fetch });
    const uploader = createTidepoolUploader({ api, auth, clientName: CLIENT_NAME, clientVersion: CLIENT_VERSION, clock });
    const r = await uploader.upload(snapshot({ glucose: [reading(0)], carbs: [{ id: 'c1', date: T0, grams: 20 }] }));
    expect(r.collections.glucose).toEqual({ ok: true, uploaded: 1 });
    const post = server.calls.filter((c) => c.url.endsWith('/data'));
    expect(post).toHaveLength(2);
    expect((callBody(post[0]!) as { type: string }[])[0]!.type).toBe('cbg');
    expect(post[0]!.headers['x-tidepool-session-token']).toBe('access-1');
  });
});
