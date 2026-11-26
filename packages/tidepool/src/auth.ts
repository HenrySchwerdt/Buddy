import { systemClock, silentLogger, type Clock, type Logger, type Millis, type SecretStore } from '@buddy/core';
import { formEncode, isRecord, parseJson, parseQuery } from './encoding';
import { PRODUCTION_ENVIRONMENT, describeEnvironment, environmentUrl, isValidEnvironment, type TidepoolEnvironment } from './environments';
import { TidepoolError, errorText, isTidepoolError } from './errors';
import { http, postForm } from './http';
import { createPkce, createState, defaultRandomBytes, type RandomBytes } from './pkce';

/** TidepoolKit asks for exactly these scopes; `offline_access` is what yields a refresh token. */
export const TIDEPOOL_SCOPE = 'openid offline_access';

/** Header Tidepool expects the (OIDC) access token in; there is no `Authorization: Bearer`. */
export const SESSION_TOKEN_HEADER = 'X-Tidepool-Session-Token';
export const TRACE_SESSION_HEADER = 'X-Tidepool-Trace-Session';

/** The access token is refreshed this long before it expires. */
export const REFRESH_SKEW_MS = 30_000;

export const DEFAULT_SESSION_KEY = 'tidepool.session';

export interface TidepoolSession {
  readonly environment: TidepoolEnvironment;
  readonly accessToken: string;
  /** Epoch ms, or `null` when the server did not say. */
  readonly accessTokenExpiresAt: Millis | null;
  readonly refreshToken: string | null;
  readonly userId: string;
  readonly username: string;
  readonly userRoles: readonly string[];
  readonly createdAt: Millis;
  /** Sent as `X-Tidepool-Trace-Session` on every request (a random UUID). */
  readonly traceId: string;
}

/** The parts of the OIDC discovery document that are used. */
export interface OidcConfiguration {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
}

export interface AuthorizationUrlParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state?: string;
}

/** Authorization request of the PKCE code flow, with the parameters in TidepoolKit's order. */
export function buildAuthorizationUrl(authorizationEndpoint: string, p: AuthorizationUrlParams): string {
  const query = formEncode({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: TIDEPOOL_SCOPE,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    state: p.state,
  });
  return `${authorizationEndpoint}${authorizationEndpoint.includes('?') ? '&' : '?'}${query}`;
}

/** Extracts the authorization code from the redirect, failing on `error=` or a `state` mismatch. */
export function parseAuthCallback(callbackUrl: string, expectedState?: string): { readonly code: string } {
  const q = parseQuery(callbackUrl);
  if (q.error) throw new TidepoolError('auth-error', `Tidepool authorization failed: ${q.error}`);
  if (expectedState !== undefined && q.state !== expectedState) throw new TidepoolError('auth-error', 'Tidepool authorization response did not match the request');
  if (!q.code) throw new TidepoolError('auth-error', 'Tidepool authorization response had no code');
  return { code: q.code };
}

/** `iss` of Tidepool's Keycloak: `<auth.url>/realms/<auth.realm>` from `/info`. */
export function issuerFromInfo(info: unknown): string | null {
  const auth = isRecord(info) && isRecord(info.auth) ? info.auth : null;
  if (!auth || typeof auth.url !== 'string' || typeof auth.realm !== 'string' || !auth.url || !auth.realm) return null;
  return `${auth.url.replace(/\/+$/, '')}/realms/${auth.realm}`;
}

function parseOidcConfiguration(json: unknown): OidcConfiguration | null {
  if (!isRecord(json)) return null;
  const { issuer, authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, revocation_endpoint: revocationEndpoint } = json;
  if (typeof issuer !== 'string' || typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') return null;
  return { issuer, authorizationEndpoint, tokenEndpoint, ...(typeof revocationEndpoint === 'string' ? { revocationEndpoint } : {}) };
}

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSec: number | null;
}

function parseTokenResponse(json: unknown): TokenResponse | null {
  if (!isRecord(json) || typeof json.access_token !== 'string' || !json.access_token) return null;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    expiresInSec: typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) ? json.expires_in : null,
  };
}

/** Everything but the tokens; the tokens get their own keys (keychain values are size-limited on some platforms). */
type StoredMeta = Omit<TidepoolSession, 'accessToken' | 'refreshToken'>;

const ACCESS_SUFFIX = '.access';
const REFRESH_SUFFIX = '.refresh';

/** Structural check for a persisted session; anything else is treated as "signed out". */
export function parseStoredSession(meta: string | null, accessToken: string | null, refreshToken: string | null): TidepoolSession | null {
  if (!meta || !accessToken) return null;
  const v = parseJson(meta);
  if (!isRecord(v) || !isValidEnvironment(v.environment)) return null;
  if (typeof v.userId !== 'string' || !v.userId) return null;
  return {
    environment: { host: v.environment.host, port: v.environment.port },
    accessToken,
    accessTokenExpiresAt: typeof v.accessTokenExpiresAt === 'number' ? v.accessTokenExpiresAt : null,
    refreshToken: refreshToken || null,
    userId: v.userId,
    username: typeof v.username === 'string' ? v.username : '',
    userRoles: Array.isArray(v.userRoles) ? v.userRoles.filter((r): r is string => typeof r === 'string') : [],
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    traceId: typeof v.traceId === 'string' ? v.traceId : '',
  };
}

export async function loadStoredSession(secrets: SecretStore, key: string): Promise<TidepoolSession | null> {
  const [meta, access, refresh] = await Promise.all([secrets.get(key), secrets.get(key + ACCESS_SUFFIX), secrets.get(key + REFRESH_SUFFIX)]);
  return parseStoredSession(meta, access, refresh);
}

/** Writes the tokens before the metadata (whose presence marks a complete session); clears in the opposite order. */
export async function saveStoredSession(secrets: SecretStore, key: string, session: TidepoolSession | null): Promise<void> {
  if (!session) {
    await secrets.set(key, null);
    await secrets.set(key + ACCESS_SUFFIX, null);
    await secrets.set(key + REFRESH_SUFFIX, null);
    return;
  }
  const { accessToken, refreshToken, ...rest } = session;
  const meta: StoredMeta = rest;
  await secrets.set(key + ACCESS_SUFFIX, accessToken);
  await secrets.set(key + REFRESH_SUFFIX, refreshToken);
  await secrets.set(key, JSON.stringify(meta));
}

const newTraceId = (random: RandomBytes): string => {
  const b = random(16).slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export interface TidepoolAuthConfig {
  /** OAuth client id registered with Tidepool for the app. Trio's `nightscout-trio` belongs to Trio: get one for Buddy. */
  readonly clientId: string;
  /** Exact redirect URI registered for `clientId` (e.g. `buddy://tidepool-auth`); passed through to the browser. */
  readonly redirectUri: string;
  /**
   * Opens `url` in the system browser sheet and resolves with the URL it was redirected to
   * (starting with `redirectUri`). Throw `TidepoolLoginCancelledError` when the user cancels.
   */
  readonly openAuthSession: (url: string, redirectUri: string) => Promise<string>;
  /** Keychain-backed store. The session is kept in three entries under `storageKey`, `.access` and `.refresh`. */
  readonly secrets: SecretStore;
  readonly fetch: typeof fetch;
  /** Default environment for `login()`. Production if omitted. */
  readonly environment?: TidepoolEnvironment;
  readonly clock?: Clock;
  readonly log?: Logger;
  readonly random?: RandomBytes;
  readonly storageKey?: string;
}

export type SessionListener = (session: TidepoolSession | null) => void;

export interface TidepoolAuth {
  /** Interactive sign-in through `openAuthSession`. */
  login(options?: { readonly environment?: TidepoolEnvironment }): Promise<TidepoolSession>;
  /** Revokes the tokens at the server (best effort, unless `revoke: false`) and forgets the session. */
  logout(options?: { readonly revoke?: boolean }): Promise<{ readonly revoked: boolean }>;
  /** The stored session as is (possibly with an expired access token), or `null`. */
  getSession(): Promise<TidepoolSession | null>;
  /** The session with a usable access token, refreshing it first when it is (nearly) expired. */
  getValidSession(): Promise<TidepoolSession>;
  /**
   * Exchanges the refresh token. Concurrent calls share one request. When `staleAccessToken`
   * no longer matches the stored session another caller already refreshed, and nothing is sent.
   * If the server refuses the refresh token the session is cleared and `not-authenticated` thrown;
   * network or server errors keep the session so the refresh can be retried.
   */
  refresh(options?: { readonly staleAccessToken?: string }): Promise<TidepoolSession>;
  subscribe(listener: SessionListener): () => void;
}

export function createTidepoolAuth(config: TidepoolAuthConfig): TidepoolAuth {
  const clock = config.clock ?? systemClock;
  const log = config.log ?? silentLogger;
  const random = config.random ?? defaultRandomBytes;
  const key = config.storageKey ?? DEFAULT_SESSION_KEY;
  const listeners = new Set<SessionListener>();
  const oidcCache = new Map<string, OidcConfiguration>();

  let cached: TidepoolSession | null | undefined;
  let refreshing: Promise<TidepoolSession> | null = null;

  async function getSession(): Promise<TidepoolSession | null> {
    if (cached === undefined) cached = await loadStoredSession(config.secrets, key);
    return cached;
  }

  async function setSession(next: TidepoolSession | null): Promise<void> {
    cached = next;
    await saveStoredSession(config.secrets, key, next);
    for (const l of [...listeners]) {
      try {
        l(next);
      } catch (e) {
        log.warn(`Tidepool session listener failed: ${errorText(e)}`);
      }
    }
  }

  async function discover(env: TidepoolEnvironment): Promise<OidcConfiguration> {
    const cacheKey = describeEnvironment(env);
    const hit = oidcCache.get(cacheKey);
    if (hit) return hit;
    const info = await http(config.fetch, environmentUrl(env, '/info'), { method: 'GET', headers: { Accept: 'application/json' } });
    if (!info.ok) throw new TidepoolError('auth-config', `Tidepool /info failed (HTTP ${info.status})`, info.status);
    const issuer = issuerFromInfo(info.json);
    if (!issuer) throw new TidepoolError('auth-config', 'Tidepool /info has no auth issuer');
    const doc = await http(config.fetch, `${issuer}/.well-known/openid-configuration`, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!doc.ok) throw new TidepoolError('auth-config', `Tidepool OpenID configuration failed (HTTP ${doc.status})`, doc.status);
    const oidc = parseOidcConfiguration(doc.json);
    if (!oidc) throw new TidepoolError('auth-config', 'Tidepool OpenID configuration is incomplete');
    oidcCache.set(cacheKey, oidc);
    return oidc;
  }

  const expiryOf = (expiresInSec: number | null): Millis | null => (expiresInSec === null ? null : clock.now() + expiresInSec * 1000);

  async function login(options?: { readonly environment?: TidepoolEnvironment }): Promise<TidepoolSession> {
    const environment = options?.environment ?? config.environment ?? PRODUCTION_ENVIRONMENT;
    const oidc = await discover(environment);
    const pkce = createPkce(random);
    const state = createState(random);
    const url = buildAuthorizationUrl(oidc.authorizationEndpoint, { clientId: config.clientId, redirectUri: config.redirectUri, codeChallenge: pkce.challenge, state });

    let callbackUrl: string;
    try {
      callbackUrl = await config.openAuthSession(url, config.redirectUri);
    } catch (e) {
      if (isTidepoolError(e)) throw e;
      throw new TidepoolError('auth-error', `Tidepool login failed: ${errorText(e)}`);
    }
    const { code } = parseAuthCallback(callbackUrl, state);

    const res = await postForm(
      config.fetch,
      oidc.tokenEndpoint,
      formEncode({ client_id: config.clientId, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: pkce.verifier, code }),
    );
    if (!res.ok) throw new TidepoolError('auth-error', `Tidepool token exchange failed (HTTP ${res.status})`, res.status);
    const token = parseTokenResponse(res.json);
    if (!token) throw new TidepoolError('auth-error', 'Tidepool token response was malformed');

    const traceId = newTraceId(random);
    const userRes = await http(config.fetch, environmentUrl(environment, '/auth/user'), {
      method: 'GET',
      headers: { Accept: 'application/json', [SESSION_TOKEN_HEADER]: token.accessToken, [TRACE_SESSION_HEADER]: traceId },
    });
    if (userRes.status === 401) throw new TidepoolError('not-authenticated', 'Tidepool rejected the new access token', 401);
    const u = userRes.json;
    if (!userRes.ok || !isRecord(u) || typeof u.userid !== 'string' || !u.userid) {
      throw new TidepoolError('unexpected', `Tidepool user lookup failed (HTTP ${userRes.status})`, userRes.status);
    }

    const session: TidepoolSession = {
      environment: { host: environment.host, port: environment.port },
      accessToken: token.accessToken,
      accessTokenExpiresAt: expiryOf(token.expiresInSec),
      refreshToken: token.refreshToken,
      userId: u.userid,
      username: typeof u.username === 'string' ? u.username : '',
      userRoles: Array.isArray(u.roles) ? u.roles.filter((r): r is string => typeof r === 'string') : [],
      createdAt: clock.now(),
      traceId,
    };
    await setSession(session);
    log.info(`Tidepool: signed in to ${describeEnvironment(environment)}`);
    return session;
  }

  async function doRefresh(): Promise<TidepoolSession> {
    const current = await getSession();
    if (!current) throw new TidepoolError('session-missing', 'Not signed in to Tidepool');
    if (!current.refreshToken) {
      await setSession(null);
      throw new TidepoolError('not-authenticated', 'Tidepool session has no refresh token');
    }
    const oidc = await discover(current.environment);
    const res = await postForm(config.fetch, oidc.tokenEndpoint, formEncode({ refresh_token: current.refreshToken, grant_type: 'refresh_token', client_id: config.clientId }));
    const body = isRecord(res.json) ? res.json : null;
    if (res.status === 401 || (res.status === 400 && body?.error === 'invalid_grant')) {
      await setSession(null);
      log.warn('Tidepool: refresh token rejected, sign-in required');
      throw new TidepoolError('not-authenticated', 'Tidepool session expired, sign in again', res.status);
    }
    if (!res.ok) throw new TidepoolError('unexpected', `Tidepool token refresh failed (HTTP ${res.status})`, res.status);
    const token = parseTokenResponse(res.json);
    if (!token) throw new TidepoolError('unexpected', 'Tidepool token response was malformed');
    const next: TidepoolSession = {
      ...current,
      accessToken: token.accessToken,
      accessTokenExpiresAt: expiryOf(token.expiresInSec),
      // Keycloak may rotate the refresh token; when it does not, the old one stays valid.
      refreshToken: token.refreshToken ?? current.refreshToken,
    };
    await setSession(next);
    log.info('Tidepool: access token refreshed');
    return next;
  }

  async function refresh(options?: { readonly staleAccessToken?: string }): Promise<TidepoolSession> {
    if (refreshing) return refreshing;
    if (options?.staleAccessToken !== undefined) {
      const current = await getSession();
      if (current && current.accessToken !== options.staleAccessToken) return current;
    }
    const run = doRefresh().finally(() => {
      refreshing = null;
    });
    refreshing = run;
    return run;
  }

  async function getValidSession(): Promise<TidepoolSession> {
    const s = await getSession();
    if (!s) throw new TidepoolError('session-missing', 'Not signed in to Tidepool');
    if (s.accessTokenExpiresAt !== null && clock.now() >= s.accessTokenExpiresAt - REFRESH_SKEW_MS) return refresh({ staleAccessToken: s.accessToken });
    return s;
  }

  async function logout(options?: { readonly revoke?: boolean }): Promise<{ readonly revoked: boolean }> {
    const s = await getSession();
    if (!s) return { revoked: false };
    let revoked = false;
    if (options?.revoke !== false) {
      try {
        const oidc = await discover(s.environment);
        if (oidc.revocationEndpoint) {
          const revoke = (token: string, hint: string) =>
            postForm(config.fetch, oidc.revocationEndpoint!, formEncode({ token, token_type_hint: hint, client_id: config.clientId }));
          const results = [await revoke(s.accessToken, 'access_token')];
          if (s.refreshToken) results.push(await revoke(s.refreshToken, 'refresh_token'));
          revoked = results.every((r) => r.ok);
        }
      } catch (e) {
        log.warn(`Tidepool: token revocation failed: ${errorText(e)}`);
      }
      if (!revoked) log.warn('Tidepool: tokens could not be revoked; the local session is removed anyway');
    }
    await setSession(null);
    log.info('Tidepool: signed out');
    return { revoked };
  }

  return {
    login,
    logout,
    getSession,
    getValidSession,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
