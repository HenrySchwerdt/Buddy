/**
 * Byte and text helpers for the Insight driver (replaces the Foundation `Data` / `String`
 * helpers of InsightKit/Common/Support.swift). Self-contained: no dependency on `atob`/`btoa`,
 * which are not guaranteed on every React Native JS engine.
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
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** UTF-8 encoder that does not need `TextEncoder`. */
export function utf8Encode(s: string): Bytes {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

/** UTF-8 decoder; invalid sequences become U+FFFD. */
export function utf8Decode(b: Bytes): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    let cp = 0xfffd;
    let len = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c < 0xe0 && i + 1 < b.length && (b[i + 1]! & 0xc0) === 0x80) {
      cp = ((c & 31) << 6) | (b[i + 1]! & 63);
      len = 2;
    } else if (c >= 0xe0 && c < 0xf0 && i + 2 < b.length && (b[i + 1]! & 0xc0) === 0x80 && (b[i + 2]! & 0xc0) === 0x80) {
      cp = ((c & 15) << 12) | ((b[i + 1]! & 63) << 6) | (b[i + 2]! & 63);
      len = 3;
    } else if (c >= 0xf0 && c < 0xf5 && i + 3 < b.length && (b[i + 1]! & 0xc0) === 0x80 && (b[i + 2]! & 0xc0) === 0x80 && (b[i + 3]! & 0xc0) === 0x80) {
      cp = ((c & 7) << 18) | ((b[i + 1]! & 63) << 12) | ((b[i + 2]! & 63) << 6) | (b[i + 3]! & 63);
      len = 4;
    }
    if (cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000)) cp = 0xfffd;
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

/** Strict hex (even length, hex digits only); `null` otherwise. */
export function hexDecode(text: string): Bytes | null {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time equality (MAC comparison). */
export function constantTimeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Platform CSPRNG; throws instead of falling back to `Math.random`. */
export function secureRandom(length: number): Bytes {
  const c = (globalThis as { crypto?: { getRandomValues?: <T extends Uint8Array>(a: T) => T } }).crypto;
  if (!c?.getRandomValues) throw new Error('Insight: no secure random source (crypto.getRandomValues) available');
  return c.getRandomValues(new Uint8Array(length));
}

export type RandomSource = (length: number) => Bytes;
