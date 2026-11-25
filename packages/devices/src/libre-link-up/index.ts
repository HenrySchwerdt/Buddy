/**
 * FreeStyle Libre 3 / 3+ via the LibreLinkUp cloud ("follower" mode).
 *
 * Why not direct BLE: Trio reads Libre 3 over BLE through LibreLoop / RoundWhiteDiscKit, but that
 * protocol authorises with an Abbott app credential (a P-256 key plus an Abbott-signed 162-byte
 * certificate) that the open-source package deliberately does not ship. Buddy has no such secret,
 * so this driver follows the same cloud API the LibreLinkUp follower app (and Nightscout / xDrip
 * connectors) use. Readings arrive with the delay of the sensor wearer's Abbott app uploading them.
 *
 * Safety/etiquette: login is only attempted when needed. Wrong credentials or pending terms-of-use
 * block further logins (wrong credentials until they change, pending terms for 30 minutes) (Abbott locks accounts after repeated
 * failures); the block is persisted in the secret store, keyed on a hash of email plus password, so
 * a restart does not clear it. HTTP 429 triggers a persisted exponential backoff (2 min up to 60
 * min). Terms-of-use are never accepted automatically and cloud polling is limited to once per minute.
 */
import { defineCgm, type DeviceMeta, type GlucoseReading, type Millis, type Trend } from '@buddy/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { isPlausibleGlucose } from '../trend';

export interface LibreLinkUpSettings {
  readonly [key: string]: string | number | boolean;
  email: string;
  password: string;
  region: string;
  patientId: string;
}

export const LIBRE_LINK_UP_ID = 'libre-link-up';
export const LIBRE_LINK_UP_SESSION_KEY = 'libre-link-up.session';

/** Minimum time between cloud polls. */
export const LIBRE_LINK_UP_MIN_INTERVAL_MS = 60_000;
/** Secret-store key of the persisted login block / 429 backoff. */
export const LIBRE_LINK_UP_LOCK_KEY = 'libre-link-up.lock';
/** First 429 backoff; doubles on every further 429 up to the maximum. */
const BACKOFF_START_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
/** Refresh the token this long before it expires. */
const TOKEN_SKEW_MS = 60_000;
const MAX_REDIRECTS = 2;

/** Client identity the LibreLinkUp API expects; the API rejects very old versions. */
const CLIENT_PRODUCT = 'llu.android';
const CLIENT_VERSION = '4.16.0';

const GLOBAL_HOST = 'https://api.libreview.io';
const REGION_CODE = /^[a-z0-9]{2,8}$/;

const REGION_OPTIONS = [
  { value: 'auto', label: 'Automatic (recommended)' },
  { value: 'us', label: 'United States' },
  { value: 'eu', label: 'Europe' },
  { value: 'eu2', label: 'Europe 2 (UK)' },
  { value: 'de', label: 'Germany' },
  { value: 'fr', label: 'France' },
  { value: 'jp', label: 'Japan' },
  { value: 'ap', label: 'Asia Pacific' },
  { value: 'au', label: 'Australia' },
  { value: 'ae', label: 'United Arab Emirates' },
  { value: 'ca', label: 'Canada' },
  { value: 'la', label: 'Latin America' },
  { value: 'ru', label: 'Russia' },
] as const;

/** API host for a region code. Only short alphanumeric codes are accepted (no host injection). */
export function libreLinkUpHost(region: string): string {
  if (region === 'auto' || region === '') return GLOBAL_HOST;
  if (!REGION_CODE.test(region)) throw new Error(`LibreLinkUp: unsupported region "${region.slice(0, 16)}"`);
  return `https://api-${region}.libreview.io`;
}

/** Parses `M/D/YYYY h:mm:ss AM|PM` (the API's `FactoryTimestamp`, which is UTC). */
export function parseLibreLinkUpTimestamp(raw: unknown): Millis | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?(AM|PM)$/i.exec(raw.trim());
  if (!m) return null;
  const [month, day, year, hour12, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (hour12 < 1 || hour12 > 12) return null;
  const hour = (hour12 % 12) + (m[7]!.toUpperCase() === 'PM' ? 12 : 0);
  const t = Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(t);
  const valid = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day && minute < 60 && second < 60;
  return valid ? t : null;
}

/** LibreLinkUp `TrendArrow`: 1 falling fast … 3 steady … 5 rising fast (no double arrows). */
export function trendFromLibreArrow(arrow: unknown): Trend {
  switch (arrow) {
    case 1: return 'singleDown';
    case 2: return 'fortyFiveDown';
    case 3: return 'flat';
    case 4: return 'fortyFiveUp';
    case 5: return 'singleUp';
    default: return 'unknown';
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function readingFromEntry(e: unknown): GlucoseReading | null {
  const row = asRecord(e);
  if (!row) return null;
  const date = parseLibreLinkUpTimestamp(row.FactoryTimestamp);
  // Always mg/dL; `Value` follows the account's display unit and may be mmol/L.
  const value = row.ValueInMgPerDl;
  if (date === null || !isPlausibleGlucose(value)) return null;
  return { date, value, trend: trendFromLibreArrow(row.TrendArrow), source: LIBRE_LINK_UP_ID };
}

/** Maps a `/llu/connections/{id}/graph` response (history plus the current value) to readings, oldest first. */
export function parseLibreLinkUpGraph(body: unknown): GlucoseReading[] {
  const data = asRecord(asRecord(body)?.data);
  const graphData = data?.graphData;
  if (!Array.isArray(graphData)) throw new Error('LibreLinkUp returned an unexpected response');
  const byDate = new Map<number, GlucoseReading>();
  const current = readingFromEntry(asRecord(data?.connection)?.glucoseMeasurement);
  const readings = [...graphData.map(readingFromEntry), current];
  for (const r of readings) if (r) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => a.date - b.date);
}

const META: DeviceMeta = {
  id: LIBRE_LINK_UP_ID,
  name: 'FreeStyle Libre 3 / 3+ (LibreLinkUp)',
  manufacturer: 'Abbott',
  description:
    'Follows a Libre 3 / 3+ sensor through the LibreLinkUp cloud. Data arrives with a delay (the Abbott app must be running and uploading), ' +
    'and Buddy cannot read the sensor directly. Requires a LibreLinkUp follower account invited by the sensor wearer. Unofficial API.',
  transport: 'network',
  maturity: 'experimental',
};

interface Session {
  readonly token: string;
  /** Epoch ms. */
  readonly expires: Millis;
  readonly host: string;
  readonly accountId: string;
  readonly emailHash: string;
}

const sha256Hex = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));

const TERMS_MESSAGE =
  'LibreLinkUp needs you to accept its updated terms of use / privacy policy. Open the LibreLinkUp app, accept them there, then try again. Buddy never accepts them for you.';
const CREDENTIALS_MESSAGE = 'LibreLinkUp login failed: wrong email or password.';

type BlockReason = 'credentials' | 'terms';
/** A terms-of-use block is retried after this pause; wrong credentials stay blocked until they change. */
const TERMS_RETRY_MS = 30 * 60_000;
interface LockState {
  /** Login block: applies only while the email+password hash matches. */
  readonly block: { readonly credHash: string; readonly reason: BlockReason; readonly at?: Millis } | null;
  /** 429 backoff: no request before `until` (epoch ms); `delayMs` is the delay that was applied. */
  readonly backoff: { readonly until: Millis; readonly delayMs: number } | null;
}
const NO_LOCK: LockState = { block: null, backoff: null };

function parseLock(raw: string | null): LockState {
  if (!raw) return NO_LOCK;
  try {
    const s = asRecord(JSON.parse(raw));
    const b = asRecord(s?.block);
    const k = asRecord(s?.backoff);
    return {
      block: b && typeof b.credHash === 'string' && (b.reason === 'credentials' || b.reason === 'terms') ? { credHash: b.credHash, reason: b.reason, ...(typeof b.at === 'number' ? { at: b.at } : {}) } : null,
      backoff: k && typeof k.until === 'number' && typeof k.delayMs === 'number' ? { until: k.until, delayMs: k.delayMs } : null,
    };
  } catch {
    return NO_LOCK;
  }
}

const hasTermsStep = (body: Record<string, unknown> | null): boolean => asRecord(asRecord(body?.data)?.step) !== null;

function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const s = asRecord(JSON.parse(raw));
    if (s && typeof s.token === 'string' && typeof s.expires === 'number' && typeof s.host === 'string' && typeof s.accountId === 'string' && typeof s.emailHash === 'string') {
      return { token: s.token, expires: s.expires, host: s.host, accountId: s.accountId, emailHash: s.emailHash };
    }
  } catch {
    // corrupt entry: fall through to a fresh login
  }
  return null;
}

export const libreLinkUpCgm = defineCgm<LibreLinkUpSettings>({
  meta: META,
  settings: [
    {
      title: 'LibreLinkUp account',
      fields: [
        { kind: 'text', key: 'email', label: 'Email', placeholder: 'follower@example.com', help: 'Your LibreLinkUp follower account (not the wearer’s LibreLink login, unless you follow yourself).' },
        { kind: 'text', key: 'password', label: 'Password', secret: true },
        { kind: 'select', key: 'region', label: 'Region', help: 'Automatic follows the redirect your account needs.', options: REGION_OPTIONS.map((o) => ({ ...o })) },
        { kind: 'text', key: 'patientId', label: 'Patient ID (optional)', help: 'Only needed when several people share their data with this account; leave empty to follow the first.' },
      ],
    },
  ],
  defaultSettings: { email: '', password: '', region: 'auto', patientId: '' },
  create(settings, ctx) {
    const email = settings.email.trim();
    const emailHash = sha256Hex(email.toLowerCase());
    let session: Session | null = null;
    let host = libreLinkUpHost(settings.region);
    let patientId: string | null = null;
    let cache: GlucoseReading[] | null = null;
    let lastAttemptAt: Millis | null = null;
    let lastError: Error | null = null;
    const credHash = sha256Hex(`${email.toLowerCase()}\n${settings.password}`);
    let lock: LockState = NO_LOCK;
    let lockLoaded = false;

    const baseHeaders = (): Record<string, string> => ({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      product: CLIENT_PRODUCT,
      version: CLIENT_VERSION,
    });

    const saveLock = async (next: LockState): Promise<void> => {
      lock = next;
      try {
        await ctx.secrets?.set(LIBRE_LINK_UP_LOCK_KEY, next.block || next.backoff ? JSON.stringify(next) : null);
      } catch {
        ctx.log.warn('LibreLinkUp: could not persist the login lock');
      }
    };

    const loadLock = async (): Promise<void> => {
      if (lockLoaded) return;
      lockLoaded = true;
      if (!ctx.secrets) return;
      try {
        lock = parseLock(await ctx.secrets.get(LIBRE_LINK_UP_LOCK_KEY));
      } catch {
        lock = NO_LOCK;
      }
    };

    const blockLogins = async (reason: BlockReason): Promise<Error> => {
      await saveLock({ ...lock, block: { credHash, reason, at: ctx.clock.now() } });
      return new Error(reason === 'terms' ? TERMS_MESSAGE : CREDENTIALS_MESSAGE);
    };

    const rateLimited = async (what: string): Promise<Error> => {
      const delayMs = lock.backoff ? Math.min(lock.backoff.delayMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
      await saveLock({ ...lock, backoff: { until: ctx.clock.now() + delayMs, delayMs } });
      return new Error(`LibreLinkUp: ${what} was rate limited (HTTP 429). Waiting ${Math.round(delayMs / 60_000)} min before the next request.`);
    };

    const clearBackoff = async (): Promise<void> => {
      if (lock.backoff) await saveLock({ ...lock, backoff: null });
    };

    /** Throws (without any network call) while a login block or 429 backoff applies. `checkBlock` also applies the credential/terms block. */
    const assertAllowed = async (checkBlock: boolean): Promise<void> => {
      await loadLock();
      if (lock.backoff && ctx.clock.now() < lock.backoff.until) {
        const mins = Math.ceil((lock.backoff.until - ctx.clock.now()) / 60_000);
        throw new Error(`LibreLinkUp: rate limited (HTTP 429). Waiting about ${mins} min before the next request.`);
      }
      if (!checkBlock || !lock.block) return;
      // Terms carry no lockout risk: once the user accepts them in the LibreLinkUp app, retry after a pause.
      const termsExpired = lock.block.reason === 'terms' && ctx.clock.now() - (lock.block.at ?? 0) >= TERMS_RETRY_MS;
      if (lock.block.credHash === credHash && !termsExpired) throw new Error(lock.block.reason === 'terms' ? TERMS_MESSAGE : CREDENTIALS_MESSAGE);
      await saveLock({ ...lock, block: null }); // credentials changed: lift the block
    };

    const persist = async (s: Session | null): Promise<void> => {
      try {
        await ctx.secrets?.set(LIBRE_LINK_UP_SESSION_KEY, s ? JSON.stringify(s) : null);
      } catch {
        ctx.log.warn('LibreLinkUp: could not persist the session');
      }
    };

    const login = async (): Promise<Session> => {
      if (!email || !settings.password) throw new Error('LibreLinkUp: enter your email and password in the CGM settings.');
      await assertAllowed(true);
      let loginHost = host;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await ctx.fetch(`${loginHost}/llu/auth/login`, {
          method: 'POST',
          headers: baseHeaders(),
          body: JSON.stringify({ email, password: settings.password }),
        });
        if (res.status === 429) throw await rateLimited('login');
        if (res.status === 401 || res.status === 403) throw await blockLogins('credentials');
        if (!res.ok) throw new Error(`LibreLinkUp login HTTP ${res.status}`);
        const body = asRecord(await res.json());
        const data = asRecord(body?.data);
        if (body?.status === 2) throw await blockLogins('credentials');
        if (hasTermsStep(body)) throw await blockLogins('terms');
        if (data?.redirect === true) {
          const region = String(data.region ?? '');
          if (!REGION_CODE.test(region)) throw new Error('LibreLinkUp redirected to an unsupported region.');
          loginHost = libreLinkUpHost(region);
          continue;
        }
        const ticket = asRecord(data?.authTicket);
        const userId = asRecord(data?.user)?.id;
        if (typeof ticket?.token !== 'string' || typeof ticket.expires !== 'number' || typeof userId !== 'string') {
          throw new Error('LibreLinkUp returned an unexpected login response');
        }
        host = loginHost;
        await saveLock(NO_LOCK);
        session = { token: ticket.token, expires: ticket.expires * 1000, host: loginHost, accountId: sha256Hex(userId), emailHash };
        await persist(session);
        ctx.log.info('LibreLinkUp: signed in');
        return session;
      }
      throw new Error('LibreLinkUp: too many region redirects.');
    };

    const restore = async (): Promise<void> => {
      if (session || !ctx.secrets) return;
      let stored: Session | null = null;
      try {
        stored = parseSession(await ctx.secrets.get(LIBRE_LINK_UP_SESSION_KEY));
      } catch {
        stored = null;
      }
      if (stored && stored.emailHash === emailHash && stored.expires - TOKEN_SKEW_MS > ctx.clock.now()) {
        session = stored;
        host = stored.host;
      }
    };

    const ensureSession = async (): Promise<Session> => {
      if (session && session.expires - TOKEN_SKEW_MS <= ctx.clock.now()) session = null;
      return session ?? login();
    };

    /** Authenticated GET returning the parsed JSON body; re-logs in once on 401. */
    const get = async (path: string, retried = false): Promise<unknown> => {
      await assertAllowed(true);
      const s = await ensureSession();
      const res = await ctx.fetch(`${s.host}${path}`, { method: 'GET', headers: { ...baseHeaders(), Authorization: `Bearer ${s.token}`, 'Account-Id': s.accountId } });
      if (res.status === 401) {
        session = null;
        await persist(null);
        if (retried) throw new Error('LibreLinkUp rejected the session (HTTP 401); sign-in did not help.');
        return get(path, true);
      }
      if (res.status === 429) throw await rateLimited('the request');
      if (!res.ok) throw new Error(`LibreLinkUp HTTP ${res.status}`);
      const body = await res.json();
      if (asRecord(body)?.status === 4 && hasTermsStep(asRecord(body))) throw await blockLogins('terms');
      await clearBackoff();
      return body;
    };

    const resolvePatient = async (): Promise<string> => {
      if (patientId) return patientId;
      const body = asRecord(await get('/llu/connections'));
      const list = Array.isArray(body?.data) ? body.data.map(asRecord).filter((c): c is Record<string, unknown> => c !== null && typeof c.patientId === 'string') : null;
      if (!list) throw new Error('LibreLinkUp returned an unexpected connections response');
      const wanted = settings.patientId.trim();
      const pick = wanted ? list.find((c) => c.patientId === wanted) : list[0];
      if (!pick) {
        throw new Error(wanted ? 'LibreLinkUp: the configured patient does not share data with this account.' : 'LibreLinkUp: no connections. Ask the sensor wearer to invite this account in the LibreLink app (Connected apps).');
      }
      patientId = String(pick.patientId);
      return patientId;
    };

    const poll = async (): Promise<GlucoseReading[]> => {
      const id = await resolvePatient();
      return parseLibreLinkUpGraph(await get(`/llu/connections/${encodeURIComponent(id)}/graph`));
    };

    return {
      meta: META,
      async start() {
        if (!email || !settings.password) throw new Error('LibreLinkUp: enter your email and password in the CGM settings.');
        await restore();
        await ensureSession();
      },
      async stop() {
        session = null;
        cache = null;
        patientId = null;
        lastAttemptAt = null;
        lastError = null;
        host = libreLinkUpHost(settings.region);
      },
      async readings(since) {
        const now = ctx.clock.now();
        if (lastAttemptAt !== null && now - lastAttemptAt < LIBRE_LINK_UP_MIN_INTERVAL_MS) {
          if (cache) return cache.filter((r) => r.date > since);
          if (lastError) throw lastError;
        }
        lastAttemptAt = now;
        try {
          cache = await poll();
          lastError = null;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          throw lastError;
        }
        return cache.filter((r) => r.date > since);
      },
    };
  },
});
