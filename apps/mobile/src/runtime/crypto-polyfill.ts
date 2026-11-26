import { getRandomValues } from 'expo-crypto';

/*
 * Hermes has no Web Crypto. Device drivers (Dexcom G6 auth, Medtrum, Omnipod DASH pairing,
 * Libre 3, Syai) need `crypto.getRandomValues` for keys and nonces; back it with the platform's
 * secure random source (SecRandomCopyBytes / SecureRandom) via expo-crypto.
 */
type Crypto = { getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T };
const g = globalThis as { crypto?: Crypto };
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues: getRandomValues as Crypto['getRandomValues'] };
}
