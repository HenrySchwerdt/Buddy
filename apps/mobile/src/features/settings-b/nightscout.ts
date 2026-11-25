import { parseNightscoutEntries, parseNightscoutProfile } from '@buddy/devices';
import * as SecureStore from 'expo-secure-store';
import { now, store } from '@/runtime/runtime';
import { NIGHTSCOUT_TOKEN_KEY } from '@/runtime/services';
import { useSettings } from '@/runtime/settings-store';

/** Nightscout helpers for Settings → Services → Nightscout (NightscoutConfig.StateModel port). */

const TIMEOUT_MS = 15_000;
const BACKFILL_HOURS = 24;
const BACKFILL_MAX_ENTRIES = 24 * 12;

export type UrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string };

/** Trio's connect(): drop a trailing slash and require https://. */
export function normalizeNightscoutUrl(raw: string): UrlCheck {
  const url = raw.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/i.test(url)) return { ok: false, message: 'Invalid URL' };
  return { ok: true, url };
}

export async function loadToken(): Promise<string> {
  return (await SecureStore.getItemAsync(NIGHTSCOUT_TOKEN_KEY)) ?? '';
}

export async function saveToken(token: string): Promise<void> {
  if (token) await SecureStore.setItemAsync(NIGHTSCOUT_TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(NIGHTSCOUT_TOKEN_KEY);
}

function withToken(url: string, token: string): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

async function getJson(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(withToken(url, token), { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (res.status === 401 || res.status === 403) throw new Error('Unauthorized. Check the access token.');
    if (!res.ok) throw new Error(`Nightscout HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('The request timed out.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Connection test: GET /api/v1/status.json with the token. */
export async function checkConnection(url: string, token: string): Promise<void> {
  const body = (await getJson(`${url}/api/v1/status.json`, token)) as { status?: unknown } | null;
  if (!body || body.status !== 'ok') throw new Error('The site did not answer like a Nightscout server.');
}

/** Reads the URL from Settings → Services → Nightscout (not from device settings). */
function connected(): { url: string } {
  const url = useSettings.getState().nightscoutUrl;
  if (!url) throw new Error('Connect to Nightscout first.');
  return { url };
}

/** Backfills the last 24 h of glucose from Nightscout into Buddy's store. Returns the count. */
export async function backfillGlucose(): Promise<number> {
  const { url } = connected();
  const token = await loadToken();
  const since = now() - BACKFILL_HOURS * 3_600_000;
  const body = await getJson(`${url}/api/v1/entries/sgv.json?count=${BACKFILL_MAX_ENTRIES}&find[date][$gte]=${since}`, token);
  const source = useSettings.getState().cgmId;
  const readings = parseNightscoutEntries(body, source).filter((r) => r.date >= since && r.date <= now());
  if (readings.length) store.addGlucose(readings);
  return readings.length;
}

/** Imports the Nightscout profile (basal, ISF, CR, targets, DIA) into the therapy profile. */
export async function importProfileFromNightscout(): Promise<void> {
  const { url } = connected();
  const token = await loadToken();
  const imported = parseNightscoutProfile(await getJson(`${url}/api/v1/profile.json`, token));
  const s = useSettings.getState();
  s.update({ profile: { ...s.profile, ...imported } });
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
