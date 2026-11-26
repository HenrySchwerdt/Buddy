import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64Url } from './encoding';

/** Source of cryptographically secure random bytes (`expo-crypto`'s `getRandomBytes` fits). */
export type RandomBytes = (length: number) => Uint8Array;

export const defaultRandomBytes: RandomBytes = (length) => {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('No secure random source: pass `random` (e.g. expo-crypto getRandomBytes)');
  return c.getRandomValues(new Uint8Array(length));
};

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** RFC 7636 S256: `base64url(sha256(ascii(verifier)))`. */
export const challengeForVerifier = (verifier: string): string => base64Url(sha256(utf8ToBytes(verifier)));

/** 32 random bytes, base64url encoded, exactly like TidepoolKit's `CodeGenerator` (43 characters). */
export function createPkce(random: RandomBytes = defaultRandomBytes): Pkce {
  const verifier = base64Url(random(32));
  return { verifier, challenge: challengeForVerifier(verifier) };
}

/** Random opaque value for the OAuth `state` parameter. */
export const createState = (random: RandomBytes = defaultRandomBytes): string => base64Url(random(16));
