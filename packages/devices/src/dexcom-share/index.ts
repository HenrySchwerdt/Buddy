import { defineCgm, type DeviceMeta, type GlucoseReading } from '@buddy/core';
import { isPlausibleGlucose, trendFromDirection } from '../trend';

export interface DexcomShareSettings {
  readonly [key: string]: string | number | boolean;
  username: string;
  password: string;
  region: 'us' | 'ous';
}

/** Public Dexcom Share application id used by the official follow apps and open-source clients. */
const APPLICATION_ID = 'd89443d2-327c-4a6f-89e5-496bbb0317db';
const HOSTS = { us: 'https://share2.dexcom.com', ous: 'https://shareous1.dexcom.com' } as const;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';

/** Parses `/Date(1700000000000)/` style Share timestamps. */
export function parseShareDate(raw: unknown): number | null {
  const m = /Date\((\d+)/.exec(String(raw));
  return m ? Number(m[1]) : null;
}

export function parseShareReadings(body: unknown): GlucoseReading[] {
  if (!Array.isArray(body)) throw new Error('Dexcom Share returned an unexpected response');
  return body.flatMap((e): GlucoseReading[] => {
    const { Value, WT, Trend } = (e ?? {}) as Record<string, unknown>;
    const date = parseShareDate(WT);
    if (!isPlausibleGlucose(Value) || date === null) return [];
    return [{ date, value: Value, trend: trendFromDirection(Trend), source: 'dexcom-share' }];
  });
}

/** Follows Dexcom Share (cloud). Experimental: unofficial API, requires Share to be enabled. */
const DEXCOM_META: DeviceMeta = {
    id: 'dexcom-share',
    name: 'Dexcom Share',
    manufacturer: 'Dexcom',
    description: 'Reads G6/G7 readings from the Dexcom Share cloud. Unofficial API; adds 5–10 min latency.',
    transport: 'network',
    maturity: 'experimental',
  };

export const dexcomShareCgm = defineCgm<DexcomShareSettings>({
  meta: DEXCOM_META,
  settings: [
    {
      title: 'Account',
      fields: [
        { kind: 'text', key: 'username', label: 'Username' },
        { kind: 'text', key: 'password', label: 'Password', secret: true },
        { kind: 'select', key: 'region', label: 'Region', options: [{ value: 'us', label: 'United States' }, { value: 'ous', label: 'Outside US' }] },
      ],
    },
  ],
  defaultSettings: { username: '', password: '', region: 'ous' },
  create(settings, ctx) {
    let session: string | null = null;
    const host = HOSTS[settings.region] ?? HOSTS.ous;
    const post = async (path: string, body: unknown) => {
      const res = await ctx.fetch(`${host}/ShareWebServices/Services/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Dexcom Share HTTP ${res.status}`);
      return res.json() as Promise<unknown>;
    };
    const login = async () => {
      const accountId = await post('General/AuthenticatePublisherAccount', { accountName: settings.username, password: settings.password, applicationId: APPLICATION_ID });
      const sessionId = await post('General/LoginPublisherAccountById', { accountId, password: settings.password, applicationId: APPLICATION_ID });
      if (typeof sessionId !== 'string' || sessionId === ZERO_ID) throw new Error('Dexcom Share login failed');
      session = sessionId;
      return sessionId;
    };
    return {
      meta: DEXCOM_META,
      start: async () => {
        await login();
      },
      stop: async () => {
        session = null;
      },
      async readings(since) {
        const minutes = Math.min(1440, Math.max(5, Math.ceil((ctx.clock.now() - since) / 60_000)));
        const fetchWith = async (id: string) =>
          parseShareReadings(await post(`Publisher/ReadPublisherLatestGlucoseValues?sessionId=${id}&minutes=${minutes}&maxCount=288`, {}));
        try {
          return (await fetchWith(session ?? (await login()))).filter((r) => r.date > since);
        } catch {
          return (await fetchWith(await login())).filter((r) => r.date > since);
        }
      },
    };
  },
});
