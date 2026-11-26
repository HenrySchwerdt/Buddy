/**
 * Byte and text helpers for the Syai driver (replaces Foundation `Data` / `String` helpers used
 * throughout SyaiKit, MIT, © 2026 Nightscout Foundation). Self-contained so the driver does not
 * depend on `atob`/`btoa`, which are not guaranteed on every React Native JS engine.
 */
import type { Bytes } from '@buddy/core';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Readonly<Record<string, number>> = Object.fromEntries([...B64].map((c, i) => [c, i]));

export function base64Encode(data: Bytes): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i]!;
    const b1 = data[i + 1];
    const b2 = data[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b1 === undefined ? '=' : B64[(n >> 6) & 63]!;
    out += b2 === undefined ? '=' : B64[n & 63]!;
  }
  return out;
}

/** Strict base64 (standard alphabet, padding optional); `null` on any invalid character. */
export function base64Decode(text: string): Bytes | null {
  const clean = text.replace(/=+$/, '');
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64_LOOKUP[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** base64url (JWT segments): `-`/`_` alphabet, no padding. */
export const base64UrlDecode = (text: string): Bytes | null => base64Decode(text.replace(/-/g, '+').replace(/_/g, '/'));

export const utf8Encode = (s: string): Bytes => new TextEncoder().encode(s);

/** UTF-8 when `TextDecoder` exists, otherwise Latin-1 (every string decoded here is ASCII). */
export function utf8Decode(b: Bytes): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(b);
  return Array.from(b, (x) => String.fromCharCode(x)).join('');
}

export const hexUpper = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Strict hex (even length, hex digits only); `null` otherwise. */
export function hexDecode(text: string): Bytes | null {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Rounds half away from zero, like Swift's `Double.rounded()` (JS `Math.round` rounds half up). */
export const roundHalfAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));
