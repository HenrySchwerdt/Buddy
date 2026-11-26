import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { parseCommandPayload, PayloadError, type CommandPayload } from './payload';

/**
 * Port of Trio's `SecureMessenger`: AES-256-GCM, key = SHA-256 of the shared secret (UTF-8), and a base64 message
 * `nonce (12 bytes) || ciphertext || tag (16 bytes)`. The secret is never logged or put into an error.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Strict standard base64 (padding optional, whitespace ignored); throws on any other character. */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '').replace(/=+$/, '');
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new DecryptionError('Invalid Base64 string');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (clean.length % 4 === 1) throw new DecryptionError('Invalid Base64 string');
  return Uint8Array.from(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=');
  }
  return out;
}

export function decryptCommand(base64EncodedString: string, sharedSecret: string): CommandPayload {
  if (!sharedSecret) throw new DecryptionError('Shared secret is empty');
  const combined = base64ToBytes(base64EncodedString);
  if (combined.length <= NONCE_BYTES) throw new DecryptionError('Encrypted data is too short to contain a nonce');
  if (combined.length < NONCE_BYTES + TAG_BYTES) throw new DecryptionError('Encrypted data is too short to contain an authentication tag');
  const key = sha256(utf8ToBytes(sharedSecret));
  let plain: Uint8Array;
  try {
    plain = gcm(key, combined.slice(0, NONCE_BYTES)).decrypt(combined.slice(NONCE_BYTES));
  } catch {
    throw new DecryptionError('Decryption failed: mismatched shared secret or corrupted message');
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new DecryptionError('Decrypted message is not valid JSON');
  }
  try {
    return parseCommandPayload(json);
  } catch (e) {
    throw e instanceof PayloadError ? new DecryptionError(e.message) : e;
  }
}

/** Counterpart for tests and tooling (the sender side): returns the base64 message. */
export function encryptCommand(payload: unknown, sharedSecret: string, nonce: Uint8Array): string {
  const key = sha256(utf8ToBytes(sharedSecret));
  const sealed = gcm(key, nonce).encrypt(utf8ToBytes(JSON.stringify(payload)));
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, nonce.length);
  return bytesToBase64(out);
}
