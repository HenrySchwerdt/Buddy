import { createMemorySecretStore, type Clock, type Logger, type SecretStore } from '@buddy/core';
import { parseQuery, type MappingContext } from '../src';

export const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const iso = (t: number): string => new Date(t).toISOString();

export const USER_ID = 'user-1234';
export const CLIENT_NAME = 'org.nightscout.Buddy';
export const CLIENT_VERSION = '1.2.3';
export const CLIENT_ID = 'buddy-test-client';
export const REDIRECT_URI = 'buddy://tidepool-auth';

export const ctx = (extra: Partial<MappingContext> = {}): MappingContext => ({ clientName: CLIENT_NAME, clientVersion: CLIENT_VERSION, userId: USER_ID, ...extra });

export const fixedClock = (start = T0): Clock & { set(t: number): void; advance(ms: number): void } => {
  let now = start;
  return { now: () => now, set: (t) => void (now = t), advance: (ms) => void (now += ms) };
};

export interface RecordingLogger extends Logger {
  readonly lines: string[];
}
export const recordingLogger = (): RecordingLogger => {
  const lines: string[] = [];
  return { lines, info: (m) => void lines.push(m), warn: (m) => void lines.push(m), error: (m) => void lines.push(m) };
};

/** RFC 7636 appendix B: these 32 bytes encode to the verifier below, whose S256 challenge is the one below. */
export const RFC_BYTES = Uint8Array.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
export const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
export const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** Returns the given byte arrays in order, then zeros. */
export const sequenceRandom = (...arrays: Uint8Array[]) => {
  let i = 0;
  return (length: number): Uint8Array => {
    const next = arrays[i++];
    return next ? next.slice(0, length) : new Uint8Array(length);
  };
};

export const STATE_BYTES = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
/** base64url of STATE_BYTES */
export const STATE_VALUE = 'AQIDBAUGBwgJCgsMDQ4PEA';

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export type Handler = (call: Call) => Response | Promise<Response>;

export const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const empty = (status: number): Response => new Response(null, { status });

/** `fetch` that dispatches on `METHOD url-without-query` and records every call. */
export function fakeFetch(routes: Record<string, Handler>): { fetch: typeof fetch; calls: Call[]; routes: Record<string, Handler> } {
  const calls: Call[] = [];
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { method: init?.method ?? 'GET', url, headers, body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    const handler = routes[`${call.method} ${url.split('?')[0]}`];
    if (!handler) return json(599, { reason: `no route for ${call.method} ${url}` });
    return handler(call);
  };
  return { fetch: fetchImpl as typeof fetch, calls, routes };
}

export const ISSUER = 'https://auth.tidepool.test/auth/realms/tidepool';
export const AUTHORIZE = `${ISSUER}/protocol/openid-connect/auth`;
export const TOKEN = `${ISSUER}/protocol/openid-connect/token`;
export const REVOKE = `${ISSUER}/protocol/openid-connect/revoke`;
const API = 'https://app.tidepool.org';

export const tokenBody = (n: number, extra: Record<string, unknown> = {}) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'openid offline_access',
  id_token: 'id-token-secret',
  ...extra,
});

/** Discovery, token, user and revocation endpoints of a pretend Tidepool; override any route per test. */
export function tidepoolServer(overrides: Record<string, Handler> = {}) {
  return fakeFetch({
    [`GET ${API}/info`]: () => json(200, { versions: { loop: {} }, auth: { realm: 'tidepool', url: 'https://auth.tidepool.test/auth' } }),
    [`GET ${ISSUER}/.well-known/openid-configuration`]: () =>
      json(200, { issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN, revocation_endpoint: REVOKE, userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo` }),
    [`POST ${TOKEN}`]: () => json(200, tokenBody(1)),
    [`GET ${API}/auth/user`]: () => json(200, { userid: USER_ID, username: 'pat@example.test', roles: ['patient'], emailVerified: true, emails: ['pat@example.test'] }),
    [`POST ${REVOKE}`]: () => empty(200),
    ...overrides,
  });
}

export const memorySecrets = (): SecretStore => createMemorySecretStore();

export const callBody = (c: Call): unknown => (c.body ? JSON.parse(c.body) : undefined);
export const formBody = (c: Call): Record<string, string> => Object.fromEntries((c.body ?? '').split('&').map((p) => p.split('=').map(decodeURIComponent) as [string, string]));

/** The `state` parameter of an authorization URL (what a real redirect would echo back). */
export const parseQueryState = (url: string): string => parseQuery(url).state ?? '';
