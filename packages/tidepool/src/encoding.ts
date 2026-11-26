import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Millis } from '@buddy/core';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 section 5 base64url without padding (no Buffer / btoa so it runs on Hermes). */
export function base64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2]!;
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 !== undefined) out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 !== undefined) out += B64[b2 & 63]!;
  }
  return out;
}

/** Lowercase hex MD5 of a UTF-8 string (Tidepool datum ids and origin ids are MD5 hashes). */
export const md5Hex = (text: string): string => bytesToHex(md5(utf8ToBytes(text)));

/** Tidepool `time`: ISO 8601 UTC with milliseconds. */
export const isoTime = (date: Millis): string => new Date(date).toISOString();

/** Rounds to `places` decimals, avoiding binary float noise in JSON. */
export const round = (value: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

const enc = (s: string): string => encodeURIComponent(s);

/** `application/x-www-form-urlencoded` / query-string encoding; `undefined` values are skipped. */
export function formEncode(params: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');
}

/** Query parameters of any URL, including custom schemes (RN's `URL` is unreliable for those). */
export function parseQuery(url: string): Record<string, string> {
  const hash = url.indexOf('#');
  const noHash = hash >= 0 ? url.slice(0, hash) : url;
  const q = noHash.indexOf('?');
  const out: Record<string, string> = {};
  if (q < 0) return out;
  for (const pair of noHash.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey.replace(/\+/g, ' '))] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      // A malformed escape is skipped rather than failing the whole login callback.
    }
  }
  return out;
}

/** `JSON.parse` that returns `null` instead of throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
