import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, defineCgm, type DeviceContext, type Logger } from '@buddy/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  BUILT_IN_CGMS,
  libreLinkUpCgm,
  libreLinkUpHost,
  parseLibreLinkUpGraph,
  parseLibreLinkUpTimestamp,
  trendFromLibreArrow,
} from '../src';
import { LIBRE_LINK_UP_LOCK_KEY } from '../src/libre-link-up';

// ── Recorded-shape fixtures (values are synthetic; field names follow the LibreLinkUp API) ──

const USER_ID = '11111111-2222-3333-4444-555555555555';
const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EXPIRES_S = 1_800_000_000; // far in the future for the fake clock below

const loginOk = (token = 'tok-1') => ({
  status: 0,
  data: { user: { id: USER_ID, country: 'DE' }, authTicket: { token, expires: EXPIRES_S, duration: 15_552_000_000 } },
});
const loginRedirect = (region: string) => ({ status: 0, data: { redirect: true, region } });
const loginBadCredentials = { status: 2, error: { message: 'notAuthenticated' } };
const loginTerms = {
  status: 4,
  data: { step: { type: 'tou', componentName: 'AcceptDocument', props: { reaccept: true, titleKey: 'x', type: 'tou' } }, user: { id: USER_ID }, authTicket: { token: 'tok-terms', expires: EXPIRES_S, duration: 1 } },
};

const entry = (factory: string, mgdl: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  FactoryTimestamp: factory,
  Timestamp: factory.replace('10:', '12:'), // local time differs from UTC; must not be used
  type: 1,
  ValueInMgPerDl: mgdl,
  MeasurementColor: 1,
  GlucoseUnits: 1,
  Value: mgdl,
  isHigh: false,
  isLow: false,
  ...extra,
});

const connections = { status: 0, data: [{ id: 'c1', patientId: PATIENT_ID, firstName: 'A', lastName: 'B', glucoseMeasurement: entry('11/25/2026 9:55:00 AM', 120, { TrendArrow: 3 }) }] };
const graph = (rows = [entry('11/25/2026 9:45:00 AM', 100), entry('11/25/2026 9:50:00 AM', 110)]) => ({
  status: 0,
  data: {
    connection: { patientId: PATIENT_ID, glucoseMeasurement: entry('11/25/2026 9:55:00 AM', 120, { TrendArrow: 3 }) },
    activeSensors: [],
    graphData: rows,
  },
});

const NOW = Date.UTC(2026, 10, 25, 10, 0, 0);

// ── Fake network ──────────────────────────────────────────────────────────────

interface Call { readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: unknown }
type Responder = (call: Call, n: number) => { status?: number; body: unknown };

function makeNet(routes: Record<string, Responder | { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const path = new URL(url).pathname.replace(PATIENT_ID, ':patient');
    const route = routes[`${call.method} ${path}`];
    if (!route) return { ok: false, status: 404, json: async () => ({}) } as Response;
    counts[path] = (counts[path] ?? 0) + 1;
    const r = typeof route === 'function' ? route(call, counts[path]) : route;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls, paths: () => calls.map((c) => `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname.replace(PATIENT_ID, ':patient')}`) };
}

const happyRoutes = () => ({
  'POST /llu/auth/login': { body: loginOk() },
  'GET /llu/connections': { body: connections },
  'GET /llu/connections/:patient/graph': { body: graph() },
});

function setup(net: ReturnType<typeof makeNet>, over: Partial<Record<string, string>> = {}, ctxOver: Partial<DeviceContext> = {}) {
  const clock = { t: NOW, now() { return this.t; } };
  const logs: string[] = [];
  const log: Logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const settings = { email: 'user@example.com', password: 'hunter2-secret', region: 'auto', patientId: '', ...over };
  const source = libreLinkUpCgm.create(settings, { clock, log, fetch: net.fetchFn, ...ctxOver });
  return { source, clock, logs, settings };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('LibreLinkUp parsing helpers', () => {
  it('parses US-formatted 12 hour UTC timestamps', () => {
    expect(parseLibreLinkUpTimestamp('11/25/2026 9:55:00 AM')).toBe(Date.UTC(2026, 10, 25, 9, 55));
    expect(parseLibreLinkUpTimestamp('11/25/2026 12:05:00 AM')).toBe(Date.UTC(2026, 10, 25, 0, 5));
    expect(parseLibreLinkUpTimestamp('11/25/2026 12:05:00 PM')).toBe(Date.UTC(2026, 10, 25, 12, 5));
    expect(parseLibreLinkUpTimestamp('1/5/2026 1:02:03 PM')).toBe(Date.UTC(2026, 0, 5, 13, 2, 3));
  });

  it('rejects unparseable timestamps', () => {
    expect(parseLibreLinkUpTimestamp('garbage')).toBeNull();
    expect(parseLibreLinkUpTimestamp(undefined)).toBeNull();
    expect(parseLibreLinkUpTimestamp('13/45/2026 1:00:00 AM')).toBeNull();
  });

  it('maps the five LibreLinkUp trend arrows', () => {
    expect([1, 2, 3, 4, 5].map(trendFromLibreArrow)).toEqual(['singleDown', 'fortyFiveDown', 'flat', 'fortyFiveUp', 'singleUp']);
    expect(trendFromLibreArrow(0)).toBe('unknown');
    expect(trendFromLibreArrow(undefined)).toBe('unknown');
  });

  it('builds regional hosts only from safe region codes', () => {
    expect(libreLinkUpHost('auto')).toBe('https://api.libreview.io');
    expect(libreLinkUpHost('eu')).toBe('https://api-eu.libreview.io');
    expect(libreLinkUpHost('eu2')).toBe('https://api-eu2.libreview.io');
    expect(() => libreLinkUpHost('evil.com/')).toThrow();
    expect(() => libreLinkUpHost('a@b')).toThrow();
  });

  it('maps graph data plus the current measurement, newest trend only, deduplicated and filtered', () => {
    const body = graph([
      entry('11/25/2026 9:45:00 AM', 100),
      entry('11/25/2026 9:50:00 AM', 110),
      entry('11/25/2026 9:50:00 AM', 110),
      entry('11/25/2026 9:40:00 AM', 20), // implausible
      { FactoryTimestamp: 'nope', ValueInMgPerDl: 100 },
    ]);
    const r = parseLibreLinkUpGraph(body);
    expect(r.map((x) => [x.date, x.value, x.trend])).toEqual([
      [Date.UTC(2026, 10, 25, 9, 45), 100, 'unknown'],
      [Date.UTC(2026, 10, 25, 9, 50), 110, 'unknown'],
      [Date.UTC(2026, 10, 25, 9, 55), 120, 'flat'],
    ]);
    expect(r.every((x) => x.source === 'libre-link-up')).toBe(true);
  });

  it('uses mg/dL values, never mmol/L', () => {
    const row = { FactoryTimestamp: '11/25/2026 9:45:00 AM', ValueInMgPerDl: 99, Value: 5.5, GlucoseUnits: 0 };
    expect(parseLibreLinkUpGraph({ data: { graphData: [row] } })[0]?.value).toBe(99);
    expect(parseLibreLinkUpGraph({ data: { graphData: [{ ...row, ValueInMgPerDl: undefined }] } })).toEqual([]);
  });

  it('throws on a malformed graph body', () => {
    expect(() => parseLibreLinkUpGraph(null)).toThrow(/unexpected/i);
    expect(() => parseLibreLinkUpGraph({ data: {} })).toThrow(/unexpected/i);
  });
});

// ── Plugin metadata ───────────────────────────────────────────────────────────

describe('LibreLinkUp plugin metadata', () => {
  it('is experimental, networked, and says it follows the cloud with delay', () => {
    expect(libreLinkUpCgm.meta.id).toBe('libre-link-up');
    expect(libreLinkUpCgm.meta.maturity).toBe('experimental');
    expect(libreLinkUpCgm.meta.transport).toBe('network');
    expect(libreLinkUpCgm.meta.description).toMatch(/delay/i);
    expect(libreLinkUpCgm.meta.description).toMatch(/cloud/i);
  });

  it('collects credentials as secret settings fields', () => {
    const fields = libreLinkUpCgm.settings.flatMap((s) => s.fields);
    expect(fields.find((f) => f.key === 'password')).toMatchObject({ kind: 'text', secret: true });
    expect(fields.find((f) => f.key === 'email')).toMatchObject({ kind: 'text' });
    expect(fields.find((f) => f.key === 'region')).toMatchObject({ kind: 'select' });
    expect(Object.keys(libreLinkUpCgm.defaultSettings)).toEqual(expect.arrayContaining(['email', 'password', 'region']));
    expect(libreLinkUpCgm.defaultSettings.password).toBe('');
  });

  it('is registered as a built-in CGM', () => {
    expect(BUILT_IN_CGMS.map((p) => p.meta.id)).toContain('libre-link-up');
    expect(defineCgm).toBeTypeOf('function');
  });
});

// ── Driver behaviour ──────────────────────────────────────────────────────────

describe('LibreLinkUp driver', () => {
  it('logs in, discovers the connection and reads the graph with the expected requests', async () => {
    const net = makeNet(happyRoutes());
    const { source } = setup(net);
    await source.start();
    const readings = await source.readings(0);
    expect(readings.map((r) => r.value)).toEqual([100, 110, 120]);
    expect(net.paths()).toEqual([
      'POST api.libreview.io/llu/auth/login',
      'GET api.libreview.io/llu/connections',
      'GET api.libreview.io/llu/connections/:patient/graph',
    ]);
    const [login, conns, gr] = net.calls;
    expect(login?.body).toEqual({ email: 'user@example.com', password: 'hunter2-secret' });
    expect(login?.headers.product).toBe('llu.android');
    expect(login?.headers.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(login?.headers.authorization).toBeUndefined();
    const accountId = bytesToHex(sha256(utf8ToBytes(USER_ID)));
    for (const c of [conns, gr]) {
      expect(c?.headers.authorization).toBe('Bearer tok-1');
      expect(c?.headers['account-id']).toBe(accountId);
      expect(c?.headers.product).toBe('llu.android');
    }
  });

  it('follows the regional redirect and keeps using the regional host', async () => {
    const net = makeNet({
      ...happyRoutes(),
      'POST /llu/auth/login': (c) => ({ body: new URL(c.url).host === 'api.libreview.io' ? loginRedirect('eu') : loginOk() }),
    });
    const { source } = setup(net);
    await source.start();
    await source.readings(0);
    expect(net.paths()).toEqual([
      'POST api.libreview.io/llu/auth/login',
      'POST api-eu.libreview.io/llu/auth/login',
      'GET api-eu.libreview.io/llu/connections',
      'GET api-eu.libreview.io/llu/connections/:patient/graph',
    ]);
  });

  it('rejects a redirect to an unsafe region code', async () => {
    const net = makeNet({ ...happyRoutes(), 'POST /llu/auth/login': { body: loginRedirect('evil.com/x') } });
    const { source } = setup(net);
    await expect(source.start()).rejects.toThrow(/region/i);
    expect(net.calls).toHaveLength(1);
  });

  it('uses a configured region directly', async () => {
    const net = makeNet(happyRoutes());
    const { source } = setup(net, { region: 'de' });
    await source.start();
    expect(net.paths()[0]).toBe('POST api-de.libreview.io/llu/auth/login');
  });

  it('surfaces terms-of-use as an error and never accepts them', async () => {
    const net = makeNet({ ...happyRoutes(), 'POST /llu/auth/login': { body: loginTerms } });
    const { source } = setup(net);
    await expect(source.start()).rejects.toThrow(/accept.*(terms|privacy)|(terms|privacy).*accept/i);
    expect(net.paths()).toEqual(['POST api.libreview.io/llu/auth/login']);
    expect(net.calls.some((c) => /tou|accept|continue|pp/i.test(new URL(c.url).pathname.replace('/llu/auth/login', '')))).toBe(false);
  });

  it('also reports terms required on a data request', async () => {
    const net = makeNet({ ...happyRoutes(), 'GET /llu/connections': { body: { status: 4, data: { step: { type: 'pp' } } } } });
    const { source } = setup(net);
    await source.start();
    await expect(source.readings(0)).rejects.toThrow(/accept/i);
  });

  it('reports bad credentials without echoing the password and stays blocked until the credentials change', async () => {
    const net = makeNet({ ...happyRoutes(), 'POST /llu/auth/login': { body: loginBadCredentials } });
    const { source, clock, logs } = setup(net);
    await expect(source.start()).rejects.toThrow(/email or password/i);
    const err = await source.readings(0).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/email or password/i);
    expect(net.calls).toHaveLength(1); // second attempt blocked locally (account lockout protection)
    expect(String((err as Error).message)).not.toContain('hunter2');
    clock.t += 24 * 3600_000; // time alone never lifts the block
    await source.readings(0).catch(() => undefined);
    expect(net.calls).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('hunter2');
    expect(logs.join('\n')).not.toContain('tok-');
  });

  it('keeps the credential block across a restart (new instance, same secret store) without storing plaintext', async () => {
    const secrets = createMemorySecretStore();
    const net = makeNet({ ...happyRoutes(), 'POST /llu/auth/login': { body: loginBadCredentials } });
    await expect(setup(net, {}, { secrets }).source.start()).rejects.toThrow(/email or password/i);
    const net2 = makeNet(happyRoutes());
    const b = setup(net2, {}, { secrets });
    await expect(b.source.start()).rejects.toThrow(/email or password/i);
    await expect(b.source.readings(0)).rejects.toThrow(/email or password/i);
    expect(net2.calls).toHaveLength(0);
    const stored = await secrets.get(LIBRE_LINK_UP_LOCK_KEY);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('user@example.com');
  });

  it('lifts the block when the password or the email changes', async () => {
    const secrets = createMemorySecretStore();
    const bad = makeNet({ ...happyRoutes(), 'POST /llu/auth/login': { body: loginBadCredentials } });
    await expect(setup(bad, {}, { secrets }).source.start()).rejects.toThrow(/email or password/i);
    for (const over of [{ password: 'new-password' }, { email: 'other@example.com' }]) {
      const net = makeNet(happyRoutes());
      const c = setup(net, over, { secrets });
      await c.source.start();
      expect((await c.source.readings(0)).length).toBe(3);
      expect(net.paths()[0]).toContain('/auth/login');
    }
  });

  it('blocks terms-of-use pending across restarts, then retries after 30 minutes (no lockout risk)', async () => {
    const secrets = createMemorySecretStore();
    const net = makeNet({ ...happyRoutes(), 'POST /llu/auth/login': { body: loginTerms } });
    const a = setup(net, {}, { secrets });
    await expect(a.source.start()).rejects.toThrow(/terms|privacy/i);
    const net2 = makeNet(happyRoutes());
    const b = setup(net2, {}, { secrets });
    b.clock.t = a.clock.t + 10 * 60_000;
    await expect(b.source.start()).rejects.toThrow(/terms|privacy/i);
    expect(net2.calls).toHaveLength(0);
    // The user accepted the terms in the LibreLinkUp app meanwhile: the next try succeeds.
    b.clock.t = a.clock.t + 31 * 60_000;
    await expect(b.source.start()).resolves.not.toThrow();
    expect(net2.calls.length).toBeGreaterThan(0);
  });

  it('serves cached readings inside the poll window while blocked, with no network call', async () => {
    const net = makeNet({ ...happyRoutes(), 'GET /llu/connections': { body: { status: 4, data: { step: { type: 'pp' } } } } });
    const { source, clock } = setup(net);
    await source.start();
    await expect(source.readings(0)).rejects.toThrow(/accept/i);
    const before = net.calls.length;
    clock.t += 10 * 60_000;
    await expect(source.readings(0)).rejects.toThrow(/accept/i);
    expect(net.calls).toHaveLength(before);
  });

  it('backs off exponentially (2, 4, 8 … 60 min) after HTTP 429 on data and resets on success', async () => {
    let limited = true;
    const net = makeNet({ ...happyRoutes(), 'GET /llu/connections/:patient/graph': () => (limited ? { status: 429, body: {} } : { body: graph() }) });
    const { source, clock } = setup(net);
    await source.start();
    const graphCalls = () => net.paths().filter((p) => p.includes('/graph')).length;
    for (const minutes of [2, 4, 8, 16, 32, 60, 60]) {
      await expect(source.readings(0)).rejects.toThrow(/rate|too many/i);
      const n = graphCalls();
      clock.t += (minutes * 60_000) - 61_000;
      await expect(source.readings(0)).rejects.toThrow(/rate|too many/i);
      expect(graphCalls()).toBe(n); // still backing off, no request
      clock.t += 62_000;
    }
    limited = false;
    expect((await source.readings(0)).length).toBe(3);
    limited = true;
    clock.t += 61_000;
    await expect(source.readings(0)).rejects.toThrow(/rate/i);
    clock.t += 2 * 60_000 + 1000;
    const n = graphCalls();
    await expect(source.readings(0)).rejects.toThrow(/rate/i);
    expect(graphCalls()).toBe(n + 1); // reset: the next wait is 2 min again, not 120
  });

  it('applies the 429 backoff to login too and persists it across a restart', async () => {
    const secrets = createMemorySecretStore();
    const net = makeNet({ ...happyRoutes(), 'POST /llu/auth/login': { status: 429, body: {} } });
    const a = setup(net, {}, { secrets });
    await expect(a.source.start()).rejects.toThrow(/rate|too many/i);
    const net2 = makeNet(happyRoutes());
    const b = setup(net2, {}, { secrets });
    b.clock.t += 60_000;
    await expect(b.source.start()).rejects.toThrow(/rate|too many/i);
    expect(net2.calls).toHaveLength(0);
    b.clock.t += 61_000; // 2 min passed
    await b.source.start();
    expect(net2.paths()[0]).toContain('/auth/login');
  });

  it('refuses to call the network without credentials', async () => {
    const net = makeNet(happyRoutes());
    const { source } = setup(net, { email: '', password: '' });
    await expect(source.start()).rejects.toThrow(/email and password/i);
    expect(net.calls).toHaveLength(0);
  });

  it('rate limits cloud polling to once per 60 s and serves the cache in between', async () => {
    const net = makeNet(happyRoutes());
    const { source, clock } = setup(net);
    await source.start();
    const first = await source.readings(0);
    clock.t += 30_000;
    const second = await source.readings(0);
    expect(second).toEqual(first);
    expect(net.paths().filter((p) => p.includes('/graph'))).toHaveLength(1);
    clock.t += 31_000;
    await source.readings(0);
    expect(net.paths().filter((p) => p.includes('/graph'))).toHaveLength(2);
    // connections lookup is cached
    expect(net.paths().filter((p) => p.endsWith('/llu/connections'))).toHaveLength(1);
  });

  it('only returns readings newer than `since`', async () => {
    const net = makeNet(happyRoutes());
    const { source } = setup(net);
    await source.start();
    const r = await source.readings(Date.UTC(2026, 10, 25, 9, 50));
    expect(r.map((x) => x.value)).toEqual([120]);
  });

  it('re-logs in once when the token is rejected with 401 and retries', async () => {
    let logins = 0;
    const net = makeNet({
      'POST /llu/auth/login': () => ({ body: loginOk(`tok-${++logins}`) }),
      'GET /llu/connections': (c) => (c.headers.authorization === 'Bearer tok-1' ? { status: 401, body: { status: 401 } } : { body: connections }),
      'GET /llu/connections/:patient/graph': { body: graph() },
    });
    const { source } = setup(net);
    await source.start();
    const r = await source.readings(0);
    expect(r).toHaveLength(3);
    expect(logins).toBe(2);
    expect(net.calls.at(-1)?.headers.authorization).toBe('Bearer tok-2');
  });

  it('does not loop when the retry is rejected too', async () => {
    const net = makeNet({ ...happyRoutes(), 'GET /llu/connections': { status: 401, body: { status: 401 } } });
    const { source } = setup(net);
    await source.start();
    await expect(source.readings(0)).rejects.toThrow(/401|auth|sign/i);
    expect(net.paths().filter((p) => p.includes('/auth/login'))).toHaveLength(2);
  });

  it('refreshes an expired token before calling the API', async () => {
    let logins = 0;
    const net = makeNet({ ...happyRoutes(), 'POST /llu/auth/login': () => ({ body: { ...loginOk(`tok-${++logins}`), data: { ...loginOk().data, authTicket: { token: `tok-${logins}`, expires: Math.floor(NOW / 1000) + 3600, duration: 1 } } } }) });
    const { source, clock } = setup(net);
    await source.start();
    await source.readings(0);
    clock.t += 2 * 3600_000;
    await source.readings(0);
    expect(logins).toBe(2);
    expect(net.calls.at(-1)?.headers.authorization).toBe('Bearer tok-2');
  });

  it('reports HTTP 429 as rate limited', async () => {
    const net = makeNet({ ...happyRoutes(), 'GET /llu/connections/:patient/graph': { status: 429, body: {} } });
    const { source } = setup(net);
    await source.start();
    await expect(source.readings(0)).rejects.toThrow(/rate|too many/i);
  });

  it('errors helpfully when nobody shares data with the account', async () => {
    const net = makeNet({ ...happyRoutes(), 'GET /llu/connections': { body: { status: 0, data: [] } } });
    const { source } = setup(net);
    await source.start();
    await expect(source.readings(0)).rejects.toThrow(/invit|share|connection/i);
  });

  it('follows the configured patient when several are shared', async () => {
    const other = { ...connections.data[0]!, patientId: 'ffffffff-0000-0000-0000-000000000000' };
    const net = makeNet({
      ...happyRoutes(),
      'GET /llu/connections': { body: { status: 0, data: [other, connections.data[0]] } },
      'GET /llu/connections/ffffffff-0000-0000-0000-000000000000/graph': { body: graph() },
    });
    const { source } = setup(net, { patientId: PATIENT_ID });
    await source.start();
    await source.readings(0);
    expect(net.calls.at(-1)?.url).toContain(`/connections/${PATIENT_ID}/graph`);
  });

  it('persists the session in the secret store and reuses it without logging in again', async () => {
    const secrets = createMemorySecretStore();
    const net1 = makeNet(happyRoutes());
    const a = setup(net1, {}, { secrets });
    await a.source.start();
    await a.source.readings(0);
    const net2 = makeNet(happyRoutes());
    const b = setup(net2, {}, { secrets });
    await b.source.start();
    await b.source.readings(0);
    expect(net2.paths().some((p) => p.includes('/auth/login'))).toBe(false);
    expect(net2.calls[0]?.headers.authorization).toBe('Bearer tok-1');
  });

  it('ignores a stored session that belongs to another account', async () => {
    const secrets = createMemorySecretStore();
    const a = setup(makeNet(happyRoutes()), {}, { secrets });
    await a.source.start();
    const net2 = makeNet(happyRoutes());
    const b = setup(net2, { email: 'other@example.com' }, { secrets });
    await b.source.start();
    expect(net2.paths()[0]).toContain('/auth/login');
  });

  it('stop() drops the in-memory session and cache', async () => {
    const net = makeNet(happyRoutes());
    const { source } = setup(net);
    await source.start();
    await source.readings(0);
    await source.stop();
    await source.start();
    expect(net.paths().filter((p) => p.includes('/auth/login'))).toHaveLength(2);
  });
});
