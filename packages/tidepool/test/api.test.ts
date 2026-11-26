import { describe, expect, it } from 'vitest';
import { createTidepoolApi, createTidepoolAuth, parseQuery, type TidepoolDatum } from '../src';
import { CLIENT_ID, REDIRECT_URI, TOKEN, USER_ID, callBody, fixedClock, formBody, json, memorySecrets, tidepoolServer, tokenBody, empty } from './fixtures';

const API = 'https://app.tidepool.org';

async function setup(routes: Parameters<typeof tidepoolServer>[0] = {}) {
  const server = tidepoolServer();
  const auth = createTidepoolAuth({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    fetch: server.fetch,
    secrets: memorySecrets(),
    clock: fixedClock(),
    random: () => new Uint8Array(32).fill(7),
    openAuthSession: async (u, r) => `${r}?code=c&state=${parseQuery(u).state}`,
  });
  await auth.login();
  server.calls.length = 0;
  Object.assign(server.routes, routes);
  return { server, auth, api: createTidepoolApi({ auth, fetch: server.fetch }) };
}

const datum = { type: 'cbg', time: '2026-11-25T12:00:00.000Z', id: 'x', origin: { id: 'o', name: 'n', version: 'v', type: 'application' }, value: 100, units: 'mg/dL' } as TidepoolDatum;

describe('TidepoolApi', () => {
  it('lists data sets filtered by client name, sending the session headers', async () => {
    const { api, server } = await setup({ [`GET ${API}/v1/users/${USER_ID}/data_sets`]: () => json(200, [{ id: 'ds-1', uploadId: 'up-1', client: { name: 'org.nightscout.Buddy', version: '1' } }]) });
    const sets = await api.listDataSets({ clientName: 'org.nightscout.Buddy', deleted: false });
    expect(sets).toEqual([{ id: 'ds-1', uploadId: 'up-1', client: { name: 'org.nightscout.Buddy', version: '1' } }]);
    const call = server.calls[0]!;
    expect(call.url).toBe(`${API}/v1/users/${USER_ID}/data_sets?client.name=org.nightscout.Buddy&deleted=false`);
    expect(call.headers['x-tidepool-session-token']).toBe('access-1');
    expect(call.headers['x-tidepool-trace-session']).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers.authorization).toBeUndefined();
  });

  it('creates a data set and unwraps the legacy envelope', async () => {
    const { api, server } = await setup({ [`POST ${API}/v1/users/${USER_ID}/data_sets`]: () => json(201, { data: { id: 'ds-2', uploadId: 'ds-2' }, meta: {} }) });
    const body = {
      type: 'upload',
      dataSetType: 'continuous',
      client: { name: 'org.nightscout.Buddy', version: '1.2.3' },
      deduplicator: { name: 'org.tidepool.deduplicator.dataset.delete.origin' },
      deviceTags: ['bgm', 'cgm', 'insulin-pump'],
    } as const;
    expect(await api.createDataSet(body)).toEqual({ id: 'ds-2', uploadId: 'ds-2' });
    expect(server.calls[0]!.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(callBody(server.calls[0]!)).toEqual(body);
  });

  it('posts data to the data set, and skips empty batches', async () => {
    const { api, server } = await setup({ [`POST ${API}/v1/data_sets/ds-1/data`]: () => json(200, { data: {} }) });
    await api.createData('ds-1', []);
    expect(server.calls).toHaveLength(0);
    await api.createData('ds-1', [datum]);
    expect(callBody(server.calls[0]!)).toEqual([datum]);
  });

  it('deletes by selector', async () => {
    const { api, server } = await setup({ [`DELETE ${API}/v1/data_sets/ds-1/data`]: () => empty(200) });
    await api.deleteData('ds-1', [{ origin: { id: 'abc' } }, { id: 'def' }]);
    expect(server.calls[0]!.method).toBe('DELETE');
    expect(callBody(server.calls[0]!)).toEqual([{ origin: { id: 'abc' } }, { id: 'def' }]);
  });

  it('refreshes once on a 401 and retries with the new token', async () => {
    let first = true;
    const { api, server } = await setup({
      [`POST ${TOKEN}`]: () => json(200, tokenBody(2)),
      [`POST ${API}/v1/data_sets/ds-1/data`]: (c) => {
        if (first) {
          first = false;
          return json(401, { code: 401, reason: 'expired' });
        }
        return c.headers['x-tidepool-session-token'] === 'access-2' ? json(200, { data: {} }) : json(401, {});
      },
    });
    await api.createData('ds-1', [datum]);
    expect(server.calls.filter((c) => c.url.endsWith('/data')).map((c) => c.headers['x-tidepool-session-token'])).toEqual(['access-1', 'access-2']);
    expect(formBody(server.calls.find((c) => c.url === TOKEN)!).grant_type).toBe('refresh_token');
  });

  it('gives up after a second 401', async () => {
    const { api } = await setup({ [`POST ${TOKEN}`]: () => json(200, tokenBody(2)), [`POST ${API}/v1/data_sets/ds-1/data`]: () => json(401, {}) });
    await expect(api.createData('ds-1', [datum])).rejects.toMatchObject({ code: 'not-authenticated', status: 401 });
  });

  it('maps statuses to error codes and keeps messages free of tokens', async () => {
    const cases: [number, unknown, string, RegExp][] = [
      [400, { errors: [{ detail: 'Value is out of range', source: { pointer: '/0/value' } }] }, 'malformed', /out of range/],
      [403, { code: 403, reason: 'Unauthorized' }, 'not-authorized', /Unauthorized/],
      [404, {}, 'not-found', /404/],
      [500, 'oops', 'unexpected', /500/],
    ];
    for (const [status, body, code, message] of cases) {
      const { api } = await setup({ [`POST ${API}/v1/data_sets/ds-1/data`]: () => json(status, body) });
      const err = await api.createData('ds-1', [datum]).catch((e: unknown) => e);
      expect(err).toMatchObject({ code, status });
      expect((err as Error).message).toMatch(message);
      expect((err as Error).message).not.toContain('access-1');
    }
  });

  it('turns a transport failure into a network error', async () => {
    const { api } = await setup({ [`POST ${API}/v1/data_sets/ds-1/data`]: () => Promise.reject(new TypeError('Network request failed')) });
    await expect(api.createData('ds-1', [datum])).rejects.toMatchObject({ code: 'network' });
  });

  it('requires a session', async () => {
    const server = tidepoolServer();
    const auth = createTidepoolAuth({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, fetch: server.fetch, secrets: memorySecrets(), openAuthSession: async () => '' });
    await expect(createTidepoolApi({ auth, fetch: server.fetch }).listDataSets({})).rejects.toMatchObject({ code: 'session-missing' });
  });
});
