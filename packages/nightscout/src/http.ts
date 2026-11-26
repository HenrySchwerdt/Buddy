import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Lowercase hex SHA-1, the form Nightscout expects in the `api-secret` header. */
export const hashApiSecret = (secret: string): string => bytesToHex(sha1(utf8ToBytes(secret)));

export function normalizeBaseUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/i.test(url)) throw new Error('Nightscout URL must start with https://');
  return url;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface NightscoutAuth {
  /** Access token, sent as `?token=`. */
  readonly token?: string;
  /** API secret, sent as `api-secret: sha1(secret)` like Trio. */
  readonly apiSecret?: string;
}

/** `base + path` with the token and any extra query parameters (values are URL-encoded). */
export function buildUrl(base: string, path: string, auth: NightscoutAuth, params: readonly (readonly [string, string])[] = []): string {
  const query = new URLSearchParams();
  for (const [k, v] of params) query.append(k, v);
  if (auth.token) query.set('token', auth.token);
  const qs = query.toString();
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

export function buildHeaders(auth: NightscoutAuth, json: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (json) headers['Content-Type'] = 'application/json';
  if (auth.apiSecret) headers['api-secret'] = hashApiSecret(auth.apiSecret);
  return headers;
}
