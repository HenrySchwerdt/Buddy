/**
 * TypeScript port of SyaiEnvelopedClient.swift, SyaiLoginCredentialProvider.swift,
 * SyaiCredentials.swift, SyaiBackend.swift, SyaiTraceID.swift and the lookup half of
 * SyaiBoundSensorLookup.swift from SyaiKit (MIT, © 2026 Nightscout Foundation).
 *
 * Talks to the Syai cloud with the user's own account: login, token refresh, and the lookup of
 * the sensor bound to the account (which hands out its BLE key group and calibration). The
 * request identity mirrors the official app, as SyaiKit does. Passwords, tokens and keys are
 * never logged.
 *
 * Not ported: sensor activation (validateDeviceByMacV3, cgmAuth/verify, bindV3, unbind) and the
 * telemetry upload to Syai.
 */
import type { Clock, Logger } from '@buddy/core';
import { base64UrlDecode, utf8Decode } from './bytes';
import { makeExchangeRequest, deriveSession, encryptRequest, decryptResponse, signApiToken, signAuthInfo, signLogin, loginEncryptInfo, type ChannelSession, type Identity } from './cloud-channel';
import type { RandomSource } from './ble-auth';
import { SyaiFailure, SyaiHttpError } from './errors';
import { mergeBoundAndAuthInfo, missingForAdoption, parseBoundSensor, type BoundSensor } from './provisioning';

export const DEFAULT_BASE_URL = 'https://api.syai.com';
export const DEFAULT_PATH_PREFIX = 'cgm/security/app/server';
export const DEFAULT_PRODUCT_MODEL = 'X1';
const PRE_LOGIN_APP_NAME = 'Syai Tag';

/** Persisted account session (stored in the keychain-backed secret store). */
export interface SyaiAccount {
  readonly refreshToken: string;
  readonly accessToken: string | null;
  /** Per-account KDF seed from login; unwraps coefficient and keyA. */
  readonly glucoseSecretKey: string | null;
  /** Stable per-install id (`Syai Tag:i:n:<uuid>`); a fresh id per launch would evict sessions. */
  readonly installDeviceId: string;
  /** Account the tokens belong to (so changed settings discard a foreign session). */
  readonly email: string | null;
}

/** Identity headers sent with every request; defaults mirror the official iOS app, as SyaiKit does. */
export interface ClientIdentity {
  readonly packageName: string;
  readonly versionName: string;
  readonly versionCode: string;
  readonly userAgent: string;
  readonly unit: string;
  readonly deviceModel: string;
  readonly language: string;
  readonly country: string;
  readonly region: string;
}

export const DEFAULT_CLIENT_IDENTITY: ClientIdentity = {
  packageName: 'com.syai.tag',
  versionName: '1.35.0',
  versionCode: '263931',
  userAgent: 'ios',
  unit: 'mmol_L',
  deviceModel: 'iPhone15,2',
  language: 'en',
  country: 'US',
  region: 'US',
};

export interface CloudDeps {
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly log: Logger;
  readonly random: RandomSource;
  readonly account: SyaiAccount;
  /** Called whenever tokens rotate, so the newest refresh token is persisted. */
  readonly onAccountChange: (account: SyaiAccount) => void;
  readonly baseUrl?: string;
  readonly pathPrefix?: string;
  readonly productModel?: string;
  readonly identity?: Partial<ClientIdentity>;
  readonly timeZone?: { readonly name: string; readonly offsetSeconds: number };
}

/** `"Syai Tag:i:n:<uuid>"` with a v3-shaped UUID, the same self-chosen shape the official iOS app uses. */
export function makeInstallDeviceId(random: RandomSource): string {
  const b = random(16).slice();
  b[6] = (b[6]! & 0x0f) | 0x30;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `Syai Tag:i:n:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Version-1 (time-based) UUID for the `traceId` header. */
export function traceId(nowMs: number, random: RandomSource): string {
  const r = random(8);
  const ts = BigInt(nowMs) * 10000n + 0x01b21dd213814000n;
  const hex = (v: bigint, width: number) => v.toString(16).padStart(width, '0');
  const timeLow = hex(ts & 0xffffffffn, 8);
  const timeMid = hex((ts >> 32n) & 0xffffn, 4);
  const timeHi = hex(((ts >> 48n) & 0x0fffn) | 0x1000n, 4);
  const clockSeq = (((r[0]! & 0x3f) | 0x80) << 8) | r[1]!;
  const node = Array.from(r.slice(2, 8), (x, i) => (i === 0 ? x | 1 : x).toString(16).padStart(2, '0')).join('');
  return `${timeLow}-${timeMid}-${timeHi}-${clockSeq.toString(16).padStart(4, '0')}-${node}`;
}

function jwtClaims(token: string | null): Readonly<Record<string, unknown>> | null {
  const part = token?.split('.')[1];
  const bytes = part ? base64UrlDecode(part) : null;
  if (!bytes) return null;
  try {
    return JSON.parse(utf8Decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const claimString = (claims: Readonly<Record<string, unknown>> | null, k: string): string | null => (typeof claims?.[k] === 'string' ? (claims[k] as string) : null);

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isOk = (code: unknown): boolean => code === undefined || code === 'OK' || code === 'SUCCESS';

interface RequestOptions {
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly productModel?: boolean;
  /** false: withhold Authorization/customerId (login pre-steps and refresh). */
  readonly authed?: boolean;
}

export class SyaiCloudClient {
  private account: SyaiAccount;
  private channel: ChannelSession | null = null;
  private seq = 0;
  private lockedOutElsewhere = false;
  private readonly identity: ClientIdentity;

  constructor(private readonly deps: CloudDeps) {
    this.account = deps.account;
    this.identity = { ...DEFAULT_CLIENT_IDENTITY, ...deps.identity };
  }

  get currentAccount(): SyaiAccount {
    return this.account;
  }

  get isLockedOutElsewhere(): boolean {
    return this.lockedOutElsewhere;
  }

  get hasSession(): boolean {
    return this.account.refreshToken !== '';
  }

  private update(patch: Partial<SyaiAccount>): void {
    this.account = { ...this.account, ...patch };
    this.deps.onAccountChange(this.account);
  }

  private get claims() {
    return jwtClaims(this.account.accessToken || this.account.refreshToken || null);
  }

  /** From the JWT `app_name` / `device_id` claims once logged in, so signature and envelope match the token. */
  private get id(): Identity {
    return { appName: claimString(this.claims, 'app_name') ?? PRE_LOGIN_APP_NAME, deviceId: claimString(this.claims, 'device_id') ?? this.account.installDeviceId };
  }

  private get userId(): string | null {
    return claimString(this.claims, 'sub');
  }

  private hasValidAccessToken(): boolean {
    const token = this.account.accessToken;
    const exp = token ? jwtClaims(token)?.exp : undefined;
    return typeof exp === 'number' && exp * 1000 - this.deps.clock.now() > 60_000;
  }

  private url(path: string): string {
    return `${this.deps.baseUrl ?? DEFAULT_BASE_URL}/${this.deps.pathPrefix ?? DEFAULT_PATH_PREFIX}/${path}`;
  }

  private baseHeaders(withProductModel: boolean): Record<string, string> {
    const now = this.deps.clock.now();
    const tz = this.deps.timeZone ?? { name: 'UTC', offsetSeconds: -new Date(now).getTimezoneOffset() * 60 };
    const id = this.identity;
    return {
      ...(withProductModel ? { productModel: this.deps.productModel ?? DEFAULT_PRODUCT_MODEL } : {}),
      timestamp: String(now),
      traceId: traceId(now, this.deps.random),
      appName: this.id.appName,
      packageName: id.packageName,
      versionName: id.versionName,
      versionCode: id.versionCode,
      ua: id.userAgent,
      timeZoneName: tz.name,
      timezone: String(tz.offsetSeconds),
      language: id.language,
      country: id.country,
      region: id.region,
      deviceId: this.id.deviceId,
      unit: id.unit,
      deviceModel: id.deviceModel,
    };
  }

  private headers(env: ReturnType<typeof encryptRequest>, o: RequestOptions): Record<string, string> {
    const auth: Record<string, string> = o.authed !== false && this.account.accessToken ? { Authorization: this.account.accessToken, customerId: this.userId ?? '' } : {};
    return {
      cipherSecretId: env.secretId,
      cipherSeq: String(env.seq),
      cipherNonceId: env.nonceId,
      cipherTimeNow: String(env.timeNow),
      cipherUserId: env.userId,
      ...this.baseHeaders(o.productModel === true),
      ...auth,
      ...o.extraHeaders,
    };
  }

  private async send(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<string> {
    let res: Response;
    try {
      res = await this.deps.fetch(url, init);
    } catch (e) {
      throw new SyaiFailure('network', `Syai request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new SyaiHttpError(res.status, text);
    return text;
  }

  private async ensureChannel(): Promise<ChannelSession> {
    const now = this.deps.clock.now();
    if (this.channel && this.channel.expireTime > now) return this.channel;
    const id = this.id;
    const { secretKey, body } = makeExchangeRequest(id.deviceId, now, this.deps.random);
    const text = await this.send(this.url('security/exchangeKey'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.baseHeaders(false) },
      body: JSON.stringify(body),
    });
    const root = asObject(safeParse(text));
    if (!root) throw new SyaiFailure('network', 'Syai handshake body not JSON');
    this.channel = deriveSession(secretKey, asObject(root.data) ?? root, id.deviceId);
    this.seq = 0;
    return this.channel;
  }

  private unwrap(text: string, channel: ChannelSession): string {
    const root = asObject(safeParse(text));
    if (!root) return text;
    const t = root.cipherText ?? root.cipherParamText ?? root.cipherBodyText;
    const m = root.cipherMac ?? root.cipherParamMac ?? root.cipherBodyMac;
    const n = root.cipherNonce ?? root.cipherParamNonce ?? root.cipherBodyNonce;
    if (typeof t !== 'string' || typeof m !== 'string' || typeof n !== 'string') return text; // unenveloped
    return decryptResponse(channel, t, m, n);
  }

  /** Enveloped GET: `cipherParam*` ride the query string (strictly percent-encoded: `+` must not become a space). */
  private async envelopedGet(path: string, body: Readonly<Record<string, unknown>>, o: RequestOptions = {}): Promise<Record<string, unknown>> {
    const channel = await this.ensureChannel();
    const env = encryptRequest(channel, this.seq++, JSON.stringify(body), this.deps.clock.now(), this.deps.random);
    const q = (s: string) => encodeURIComponent(s);
    const query = `cipherParamText=${q(env.text)}&cipherParamMac=${q(env.mac)}&cipherParamNonce=${q(env.nonce)}&cipherParamSignature=${q(env.signature)}`;
    const text = await this.send(`${this.url(path)}?${query}`, { method: 'GET', headers: this.headers(env, o) });
    return this.parsed(this.unwrap(text, channel));
  }

  /** Enveloped POST: `cipherBody*` ride in the JSON body. */
  private async envelopedPost(path: string, body: Readonly<Record<string, unknown>>, o: RequestOptions = {}): Promise<Record<string, unknown>> {
    const channel = await this.ensureChannel();
    const env = encryptRequest(channel, this.seq++, JSON.stringify(body), this.deps.clock.now(), this.deps.random);
    const text = await this.send(this.url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers(env, o) },
      body: JSON.stringify({ cipherBodyText: env.text, cipherBodyMac: env.mac, cipherBodyNonce: env.nonce, cipherBodySignature: env.signature }),
    });
    return this.parsed(this.unwrap(text, channel));
  }

  private parsed(text: string): Record<string, unknown> {
    const root = asObject(safeParse(text));
    if (!root) throw new SyaiFailure('network', 'Syai response was not a JSON object');
    return root;
  }

  /** `GET user/apiToken` then `POST user/mail/login`. */
  async login(email: string, password: string): Promise<void> {
    try {
      const ts1 = String(this.deps.clock.now());
      const tokenRoot = await this.envelopedGet('user/apiToken', { signature: signApiToken(this.id, ts1) }, { authed: false, extraHeaders: { timestamp: ts1 } });
      const data = tokenRoot.data;
      const apiToken = typeof data === 'string' ? data : (asObject(data)?.apiToken ?? tokenRoot.apiToken);
      if (typeof apiToken !== 'string' || apiToken === '') throw new SyaiFailure('accountRejected', 'Syai login: server returned no apiToken.');

      const ts = String(this.deps.clock.now());
      const root = await this.envelopedPost(
        'user/mail/login',
        { encryptInfo: loginEncryptInfo(email, password), apiToken, signature: signLogin(this.id, ts, apiToken, email, password) },
        { authed: false, extraHeaders: { timestamp: ts } },
      );
      if (!isOk(root.code)) {
        const msg = typeof root.msg === 'string' && root.msg ? `: ${root.msg}` : '';
        throw new SyaiFailure('accountRejected', `Syai login rejected (${String(root.code)})${msg}`);
      }
      const dataObj = asObject(root.data) ?? root;
      const jwt = asObject(dataObj.jwtToken) ?? dataObj;
      const access = (jwt.accessToken ?? dataObj.accessToken) as unknown;
      const refresh = (jwt.refreshToken ?? dataObj.refreshToken) as unknown;
      if (typeof access !== 'string' || !access) throw new SyaiFailure('accountRejected', 'Syai login: no accessToken in response');
      if (typeof refresh !== 'string' || !refresh) throw new SyaiFailure('accountRejected', 'Syai login: no refreshToken in response');
      const gsk = dataObj.glucoseSecretKey;
      this.lockedOutElsewhere = false;
      this.update({ accessToken: access, refreshToken: refresh, glucoseSecretKey: typeof gsk === 'string' && gsk ? gsk : this.account.glucoseSecretKey });
    } catch (e) {
      throw e instanceof SyaiFailure ? e : new SyaiFailure('network', `Syai login failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** `POST jwt/refreshToken`: empty body, enveloped, with the current tokens as headers. */
  async refreshAccessToken(): Promise<void> {
    if (!this.hasSession) throw new SyaiFailure('notConfigured', 'Syai backend not configured (log in first).');
    const extraHeaders: Record<string, string> = { customerId: this.userId ?? '', refreshToken: this.account.refreshToken };
    if (this.account.accessToken) extraHeaders.accessToken = this.account.accessToken;
    let root: Record<string, unknown>;
    try {
      root = await this.envelopedPost('jwt/refreshToken', {}, { authed: false, extraHeaders });
    } catch (e) {
      if (e instanceof SyaiHttpError && e.isLoggedInElsewhere) this.lockedOutElsewhere = true;
      throw e;
    }
    const dataObj = asObject(root.data) ?? root;
    const jwt = asObject(dataObj.jwtToken) ?? dataObj;
    const access = (jwt.accessToken ?? dataObj.accessToken) as unknown;
    if (typeof access !== 'string' || !access) {
      if (typeof root.code === 'string' && root.code !== 'OK') {
        if (root.code === 'AuthFailed_LoginElsewhere') this.lockedOutElsewhere = true;
        throw new SyaiHttpError(401, JSON.stringify({ code: root.code }));
      }
      throw new SyaiFailure('network', 'Syai refresh response had no accessToken');
    }
    const refresh = (jwt.refreshToken ?? dataObj.refreshToken) as unknown;
    const gsk = dataObj.glucoseSecretKey;
    this.lockedOutElsewhere = false;
    this.update({
      accessToken: access,
      refreshToken: typeof refresh === 'string' && refresh ? refresh : this.account.refreshToken,
      glucoseSecretKey: typeof gsk === 'string' && gsk ? gsk : this.account.glucoseSecretKey,
    });
  }

  async ensureAccessToken(): Promise<void> {
    if (this.hasValidAccessToken()) return;
    if (this.lockedOutElsewhere) throw new SyaiFailure('accountLoggedOutElsewhere', 'Syai account is logged in elsewhere (a re-login is required, not a retry).');
    await this.refreshAccessToken();
  }

  /** `GET device/authInfo`; the BLE keys and durations the official app restores a sensor from. */
  private async authInfo(mac: string): Promise<Record<string, unknown> | null> {
    await this.ensureAccessToken();
    const ts = String(this.deps.clock.now());
    const root = await this.envelopedGet('device/authInfo', { mac, sign: signAuthInfo(this.id, mac, ts) }, { extraHeaders: { timestamp: ts }, productModel: true });
    if (!isOk(root.code)) throw new SyaiFailure('accountRejected', `Syai authInfo answered '${String(root.code)}'`);
    return asObject(root.data) ?? root;
  }

  /**
   * The sensor bound to the account (typically activated by the official app), or null. Requires
   * the sensor's own coefficients: it is never decoded on defaults.
   */
  async getBoundSensor(): Promise<BoundSensor | null> {
    await this.ensureAccessToken();
    const root = await this.envelopedGet('deviceBind/getBindDevice', {});
    const code = typeof root.code === 'string' ? root.code : 'OK';
    if (code !== 'OK') throw new SyaiFailure('accountRejected', `Syai server returned '${code}' when looking up your sensor.`);
    let body = asObject(root.data);
    const mac = typeof body?.mac === 'string' ? body.mac : '';
    if (!body || !mac) return null;
    // authInfo's values win; if it fails, the bound record alone is enough when it carries the keys.
    try {
      body = mergeBoundAndAuthInfo(body, await this.authInfo(mac));
    } catch (e) {
      this.deps.log.warn(`Syai: authInfo failed for the bound sensor: ${e instanceof Error ? e.message : String(e)}`);
      if (missingForAdoption(body)) throw e;
    }
    return parseBoundSensor(body, this.account.glucoseSecretKey);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
