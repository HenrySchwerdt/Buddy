import { describe, expect, it, vi } from 'vitest';
import { createMemorySecretStore } from '@buddy/core';
import {
  DEFAULT_SESSION_KEY,
  TidepoolError,
  TidepoolLoginCancelledError,
  buildAuthorizationUrl,
  challengeForVerifier,
  createTidepoolAuth,
  issuerFromInfo,
  loadStoredSession,
  parseAuthCallback,
  parseStoredSession,
  type TidepoolAuthConfig,
  type TidepoolSession,
} from '../src';
import {
  AUTHORIZE,
  CLIENT_ID,
  RFC_BYTES,
  RFC_CHALLENGE,
  RFC_VERIFIER,
  REDIRECT_URI,
  REVOKE,
  STATE_BYTES,
  STATE_VALUE,
  T0,
  TOKEN,
  USER_ID,
  empty,
  fixedClock,
  formBody,
  json,
  recordingLogger,
  sequenceRandom,
  tidepoolServer,
  tokenBody,
} from './fixtures';

const CALLBACK_OK = `${REDIRECT_URI}?code=auth-code-1&state=${STATE_VALUE}`;

function setup(options: { server?: ReturnType<typeof tidepoolServer>; callback?: string | (() => Promise<string>) } = {}) {
  const server = options.server ?? tidepoolServer();
  const secrets = createMemorySecretStore();
  const clock = fixedClock();
  const log = recordingLogger();
  const openedWith: { url: string; redirectUri: string }[] = [];
  const config: TidepoolAuthConfig = {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    fetch: server.fetch,
    secrets,
    clock,
    log,
    random: sequenceRandom(RFC_BYTES, STATE_BYTES, new Uint8Array(16).fill(0xab)),
    openAuthSession: async (url, redirectUri) => {
      openedWith.push({ url, redirectUri });
      const cb = options.callback ?? CALLBACK_OK;
      return typeof cb === 'string' ? cb : cb();
    },
  };
  return { auth: createTidepoolAuth(config), server, secrets, clock, log, openedWith };
}

describe('authorization URL', () => {
  it('carries the PKCE parameters in TidepoolKit order', () => {
    const url = buildAuthorizationUrl(AUTHORIZE, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeChallenge: RFC_CHALLENGE, state: 'xyz' });
    expect(url).toBe(
      `${AUTHORIZE}?client_id=buddy-test-client&redirect_uri=buddy%3A%2F%2Ftidepool-auth&response_type=code&scope=openid%20offline_access` +
        `&code_challenge=${RFC_CHALLENGE}&code_challenge_method=S256&state=xyz`,
    );
  });
  it('appends to an endpoint that already has a query', () => {
    expect(buildAuthorizationUrl('https://a.test/auth?x=1', { clientId: 'c', redirectUri: 'r', codeChallenge: 'h' })).toMatch(/^https:\/\/a\.test\/auth\?x=1&client_id=c&/);
  });
  it('derives the issuer from /info', () => {
    expect(issuerFromInfo({ auth: { url: 'https://auth.example.test/auth/', realm: 'tidepool' } })).toBe('https://auth.example.test/auth/realms/tidepool');
    expect(issuerFromInfo({ auth: { realm: 'tidepool' } })).toBeNull();
    expect(issuerFromInfo(null)).toBeNull();
  });
});

describe('callback parsing', () => {
  it('returns the code', () => {
    expect(parseAuthCallback(CALLBACK_OK, STATE_VALUE)).toEqual({ code: 'auth-code-1' });
  });
  it('fails on error, state mismatch and missing code', () => {
    expect(() => parseAuthCallback(`${REDIRECT_URI}?error=access_denied`)).toThrow(/access_denied/);
    expect(() => parseAuthCallback(`${REDIRECT_URI}?code=c&state=other`, STATE_VALUE)).toThrow(/did not match/);
    expect(() => parseAuthCallback(`${REDIRECT_URI}?state=${STATE_VALUE}`, STATE_VALUE)).toThrow(/no code/);
  });
});

describe('login', () => {
  it('runs discovery, PKCE exchange and user lookup, then stores the session', async () => {
    const { auth, server, secrets, openedWith } = setup();
    const session = await auth.login();

    expect(session).toMatchObject({
      environment: { host: 'app.tidepool.org', port: 443 },
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: T0 + 3_600_000,
      userId: USER_ID,
      username: 'pat@example.test',
      userRoles: ['patient'],
      createdAt: T0,
      traceId: 'abababab-abab-4bab-abab-abababababab',
    });

    // The browser got the authorization URL with the challenge of the verifier that is later exchanged.
    expect(openedWith).toHaveLength(1);
    expect(openedWith[0]!.redirectUri).toBe(REDIRECT_URI);
    expect(openedWith[0]!.url).toBe(buildAuthorizationUrl(AUTHORIZE, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeChallenge: RFC_CHALLENGE, state: STATE_VALUE }));

    const methods = server.calls.map((c) => `${c.method} ${c.url}`);
    expect(methods).toEqual([
      'GET https://app.tidepool.org/info',
      `GET ${AUTHORIZE.replace('/protocol/openid-connect/auth', '')}/.well-known/openid-configuration`,
      `POST ${TOKEN}`,
      'GET https://app.tidepool.org/auth/user',
    ]);
    const tokenCall = server.calls[2]!;
    expect(tokenCall.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(formBody(tokenCall)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: RFC_VERIFIER,
      code: 'auth-code-1',
    });
    expect(challengeForVerifier(formBody(tokenCall).code_verifier!)).toBe(RFC_CHALLENGE);
    expect(server.calls[3]!.headers['x-tidepool-session-token']).toBe('access-1');

    expect(await loadStoredSession(secrets, DEFAULT_SESSION_KEY)).toEqual(session);
    // Tokens live in their own entries, never in the metadata entry.
    expect(await secrets.get(DEFAULT_SESSION_KEY)).not.toMatch(/access-1|refresh-1/);
    expect(await secrets.get(`${DEFAULT_SESSION_KEY}.access`)).toBe('access-1');
    expect(await secrets.get(`${DEFAULT_SESSION_KEY}.refresh`)).toBe('refresh-1');
  });

  it('uses the environment it is told to', async () => {
    const server = tidepoolServer({
      'GET http://localhost:8009/info': () => json(200, { auth: { realm: 'tidepool', url: 'https://auth.tidepool.test/auth' } }),
      'GET http://localhost:8009/auth/user': () => json(200, { userid: 'dev-user', username: 'dev', roles: [] }),
    });
    const { auth } = setup({ server });
    const session = await auth.login({ environment: { host: 'localhost', port: 8009 } });
    expect(session.environment).toEqual({ host: 'localhost', port: 8009 });
    expect(session.userId).toBe('dev-user');
  });

  it('never logs a token', async () => {
    const { auth, log } = setup();
    await auth.login();
    await auth.refresh();
    const text = log.lines.join('\n');
    expect(text).not.toMatch(/access-|refresh-|id-token|auth-code|code_verifier/);
    expect(log.lines.length).toBeGreaterThan(0);
  });

  it('lets a cancelled sheet through unchanged and stores nothing', async () => {
    const { auth, secrets } = setup({
      callback: () => {
        throw new TidepoolLoginCancelledError();
      },
    });
    await expect(auth.login()).rejects.toMatchObject({ code: 'login-cancelled' });
    expect(await secrets.get(DEFAULT_SESSION_KEY)).toBeNull();
  });

  it('wraps other browser failures', async () => {
    const { auth } = setup({ callback: () => Promise.reject(new Error('browser crashed')) });
    await expect(auth.login()).rejects.toMatchObject({ code: 'auth-error', message: expect.stringContaining('browser crashed') });
  });

  it('rejects a callback with the wrong state before touching the token endpoint', async () => {
    const { auth, server } = setup({ callback: `${REDIRECT_URI}?code=c&state=forged` });
    await expect(auth.login()).rejects.toMatchObject({ code: 'auth-error' });
    expect(server.calls.some((c) => c.url === TOKEN)).toBe(false);
  });

  it('reports a failed token exchange without leaking the response', async () => {
    const server = tidepoolServer({ [`POST ${TOKEN}`]: () => json(400, { error: 'invalid_grant', error_description: 'code secret-code expired' }) });
    const { auth } = setup({ server });
    const err = await auth.login().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TidepoolError);
    expect((err as TidepoolError).code).toBe('auth-error');
    expect((err as TidepoolError).message).not.toContain('secret-code');
  });

  it('fails clearly when /info has no auth section', async () => {
    const server = tidepoolServer({ 'GET https://app.tidepool.org/info': () => json(200, { versions: {} }) });
    const { auth } = setup({ server });
    await expect(auth.login()).rejects.toMatchObject({ code: 'auth-config' });
  });
});

describe('refresh', () => {
  async function loggedIn(overrides: Parameters<typeof tidepoolServer>[0] = {}) {
    const ctx = setup();
    await ctx.auth.login();
    ctx.server.calls.length = 0;
    Object.assign(ctx.server.routes, overrides); // only after sign-in, which uses the default token response
    return ctx;
  }

  it('exchanges the refresh token and rotates both tokens', async () => {
    const { auth, server, clock, secrets } = await loggedIn({ [`POST ${TOKEN}`]: () => json(200, tokenBody(2)) });
    clock.advance(10 * 60_000);
    const next = await auth.refresh();
    expect(next).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', accessTokenExpiresAt: T0 + 10 * 60_000 + 3_600_000, userId: USER_ID });
    expect(formBody(server.calls.find((c) => c.url === TOKEN)!)).toEqual({ refresh_token: 'refresh-1', grant_type: 'refresh_token', client_id: CLIENT_ID });
    expect((await loadStoredSession(secrets, DEFAULT_SESSION_KEY))?.accessToken).toBe('access-2');
  });

  it('keeps the old refresh token when the server sends none', async () => {
    const { auth } = await loggedIn({ [`POST ${TOKEN}`]: () => json(200, { access_token: 'access-9', expires_in: 60 }) });
    expect(await auth.refresh()).toMatchObject({ accessToken: 'access-9', refreshToken: 'refresh-1' });
  });

  it('clears the session and asks for a new login when the refresh token is refused', async () => {
    for (const refused of [() => json(401, {}), () => json(400, { error: 'invalid_grant' })]) {
      const { auth, secrets } = await loggedIn({ [`POST ${TOKEN}`]: refused });
      const seen: (TidepoolSession | null)[] = [];
      auth.subscribe((s) => seen.push(s));
      await expect(auth.refresh()).rejects.toMatchObject({ code: 'not-authenticated' });
      expect(await auth.getSession()).toBeNull();
      expect(await secrets.get(DEFAULT_SESSION_KEY)).toBeNull();
      expect(await secrets.get(`${DEFAULT_SESSION_KEY}.access`)).toBeNull();
      expect(await secrets.get(`${DEFAULT_SESSION_KEY}.refresh`)).toBeNull();
      expect(seen).toEqual([null]);
    }
  });

  it('keeps the session through server and network errors so it can be retried', async () => {
    const { auth } = await loggedIn({ [`POST ${TOKEN}`]: () => json(503, {}) });
    await expect(auth.refresh()).rejects.toMatchObject({ code: 'unexpected', status: 503 });
    expect((await auth.getSession())?.accessToken).toBe('access-1');

    const down = await loggedIn({ [`POST ${TOKEN}`]: () => Promise.reject(new TypeError('offline')) });
    await expect(down.auth.refresh()).rejects.toMatchObject({ code: 'network' });
    expect((await down.auth.getSession())?.refreshToken).toBe('refresh-1');
  });

  it('shares one request between concurrent callers', async () => {
    const handler = vi.fn(() => json(200, tokenBody(2)));
    const { auth } = await loggedIn({ [`POST ${TOKEN}`]: handler });
    const [a, b] = await Promise.all([auth.refresh(), auth.refresh()]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('skips the request when the stale token was already replaced', async () => {
    const handler = vi.fn(() => json(200, tokenBody(2)));
    const { auth } = await loggedIn({ [`POST ${TOKEN}`]: handler });
    await auth.refresh();
    const again = await auth.refresh({ staleAccessToken: 'access-1' });
    expect(again.accessToken).toBe('access-2');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('getValidSession refreshes shortly before expiry, not before', async () => {
    const handler = vi.fn(() => json(200, tokenBody(2)));
    const { auth, clock } = await loggedIn({ [`POST ${TOKEN}`]: handler });
    clock.advance(3_600_000 - 31_000);
    expect((await auth.getValidSession()).accessToken).toBe('access-1');
    clock.advance(2_000);
    expect((await auth.getValidSession()).accessToken).toBe('access-2');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses without a session', async () => {
    const { auth } = setup();
    await expect(auth.getValidSession()).rejects.toMatchObject({ code: 'session-missing' });
    await expect(auth.refresh()).rejects.toMatchObject({ code: 'session-missing' });
  });
});

describe('logout', () => {
  it('revokes both tokens and clears the session', async () => {
    const { auth, server, secrets } = setup();
    await auth.login();
    server.calls.length = 0;
    const seen: (TidepoolSession | null)[] = [];
    auth.subscribe((s) => seen.push(s));
    expect(await auth.logout()).toEqual({ revoked: true });
    const revokes = server.calls.filter((c) => c.url === REVOKE).map(formBody);
    expect(revokes).toEqual([
      { token: 'access-1', token_type_hint: 'access_token', client_id: CLIENT_ID },
      { token: 'refresh-1', token_type_hint: 'refresh_token', client_id: CLIENT_ID },
    ]);
    expect(await secrets.get(DEFAULT_SESSION_KEY)).toBeNull();
    expect(seen).toEqual([null]);
  });

  it('still signs out locally when revocation fails, and says so', async () => {
    const { auth, log } = setup({ server: tidepoolServer({ [`POST ${REVOKE}`]: () => empty(500) }) });
    await auth.login();
    expect(await auth.logout()).toEqual({ revoked: false });
    expect(await auth.getSession()).toBeNull();
    expect(log.lines.join('\n')).toMatch(/could not be revoked/);
  });

  it('can skip revocation (offline sign-out)', async () => {
    const { auth, server } = setup();
    await auth.login();
    server.calls.length = 0;
    await auth.logout({ revoke: false });
    expect(server.calls).toHaveLength(0);
    expect(await auth.getSession()).toBeNull();
  });

  it('is a no-op when signed out', async () => {
    const { auth } = setup();
    expect(await auth.logout()).toEqual({ revoked: false });
  });
});

describe('stored session', () => {
  it('survives a restart and ignores junk', async () => {
    const first = setup();
    await first.auth.login();
    const second = createTidepoolAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      fetch: first.server.fetch,
      secrets: first.secrets,
      openAuthSession: async () => '',
    });
    expect((await second.getSession())?.userId).toBe(USER_ID);
    expect(parseStoredSession('not json', 'a', 'r')).toBeNull();
    expect(parseStoredSession(JSON.stringify({ userId: 'u', environment: { host: 'bad host', port: 1 } }), 'a', 'r')).toBeNull();
    expect(parseStoredSession(null, 'a', 'r')).toBeNull();
    // A half-written session (no access token) counts as signed out.
    expect(parseStoredSession(JSON.stringify({ userId: 'u', environment: { host: 'app.tidepool.org', port: 443 } }), null, 'r')).toBeNull();
  });
});
