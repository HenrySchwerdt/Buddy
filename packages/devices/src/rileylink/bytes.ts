/** Small byte helpers shared by the RileyLink port (big-endian writers, ASCII). */
import type { Bytes } from '@buddy/core';

export const writeU16be = (v: number): Bytes => new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
export const writeU32be = (v: number): Bytes => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

/** Clamp to the unsigned range of `bits` (Swift `UIntN(clamping:)`); NaN becomes 0. */
export const clampUnsigned = (v: number, bits: 8 | 16 | 32): number => {
  if (!Number.isFinite(v)) return v > 0 ? 2 ** bits - 1 : 0;
  return Math.min(Math.max(Math.trunc(v), 0), 2 ** bits - 1);
};

/** UTF-8 decode restricted to what firmware version strings contain (ASCII); non-ASCII bytes map to U+FFFD. */
export const asciiToString = (b: Bytes): string => {
  let out = '';
  for (const x of b) out += x < 0x80 ? String.fromCharCode(x) : '�';
  return out;
};

export const stringToBytes = (s: string): Bytes => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
