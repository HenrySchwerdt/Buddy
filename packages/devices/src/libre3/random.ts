/**
 * Platform CSPRNG access for the Libre 3 driver (replaces `SecRandomCopyBytes` in RoundWhiteDiscKit
 * `Pairing/PairingFlow.swift` and LibreLoop `LibreLoopPairingService.swift`; MIT, (c) the
 * RoundWhiteDiscKit and LibreLoop authors).
 */
import type { Bytes } from '@buddy/core';

export type RandomSource = (length: number) => Bytes;

/** Platform CSPRNG; fails loudly instead of falling back to a weak source. */
export const secureRandom: RandomSource = (length) => {
  const c = (globalThis as { crypto?: { getRandomValues?: <T extends Uint8Array>(a: T) => T } }).crypto;
  if (!c?.getRandomValues) throw new Error('Libre 3: no secure random source (crypto.getRandomValues) available');
  return c.getRandomValues(new Uint8Array(length));
};
