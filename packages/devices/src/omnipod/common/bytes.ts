/**
 * Byte helpers for the Omnipod message layer. Part of the TypeScript port of OmnipodKit
 * (MIT License, (c) LoopKit Authors): replaces the Swift `Data` big-endian extensions.
 * All Omnipod message fields are big-endian.
 */
import type { Bytes } from '@buddy/core';

export { concatBytes, fromHex, hex, u16be, u32be } from '@buddy/core';

export const be16 = (v: number): Bytes => new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
export const be32 = (v: number): Bytes => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

export const bytesEqual = (a: Bytes, b: Bytes): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export const xorBytes = (a: Bytes, b: Bytes): Bytes => {
  if (a.length !== b.length) throw new Error('xorBytes: length mismatch');
  return a.map((x, i) => x ^ b[i]!);
};

/** Platform CSPRNG; throws instead of falling back to Math.random. */
export function randomBytes(length: number): Bytes {
  const c = (globalThis as { crypto?: { getRandomValues?: <T extends Uint8Array>(a: T) => T } }).crypto;
  if (!c?.getRandomValues) throw new Error('Omnipod: no secure random source (crypto.getRandomValues) available');
  return c.getRandomValues(new Uint8Array(length));
}
