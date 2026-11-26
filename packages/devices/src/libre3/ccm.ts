/**
 * AES-128-CCM (NIST SP 800-38C), built on the AES block primitive of @noble/ciphers.
 *
 * TypeScript port of RoundWhiteDiscKit `Crypto/AESCCM.swift` (MIT, (c) the RoundWhiteDiscKit authors).
 * Libre 3 Phase 5/6 and the post-authorization data plane both use M = 4 (4-byte tag).
 */
import type { Bytes } from '@buddy/core';
import { ecb } from '@noble/ciphers/aes.js';

export class CcmAuthError extends Error {
  constructor() {
    super('AES-CCM tag mismatch');
    this.name = 'CcmAuthError';
  }
}

type BlockEncrypt = (block: Bytes) => Bytes;

function blockEncryptor(key: Bytes): BlockEncrypt {
  if (key.length !== 16) throw new Error('AES-128 requires a 16-byte key');
  // a noble cipher instance encrypts once; one instance per 16-byte block keeps this stateless
  return (block) => ecb(key, { disablePadding: true }).encrypt(block);
}

const xorBytes = (a: Bytes, b: Bytes): Bytes => Uint8Array.from(a, (x, i) => x ^ b[i]!);

function checkParameters(nonce: Bytes, tagLength: number, dataLength: number): number {
  const l = 15 - nonce.length;
  if (l < 2 || l > 8) throw new Error('AES-CCM: invalid nonce length');
  if (![4, 6, 8, 10, 12, 14, 16].includes(tagLength)) throw new Error('AES-CCM: invalid tag length');
  if (l < 7 && dataLength > 2 ** (8 * l) - 1) throw new Error('AES-CCM: message too long');
  return l;
}

/** B0 || formatted AAD, zero-padded to a block boundary. */
function formatHeader(nonce: Bytes, aad: Bytes, dataLength: number, tagLength: number): Bytes {
  const l = 15 - nonce.length;
  const b0 = new Uint8Array(16);
  b0[0] = (aad.length > 0 ? 0x40 : 0) | (((tagLength - 2) / 2) << 3) | (l - 1);
  b0.set(nonce, 1);
  let q = dataLength;
  for (let i = 0; i < l; i++) {
    b0[15 - i] = q & 0xff;
    q = Math.floor(q / 256);
  }
  if (aad.length === 0) return b0;
  if (aad.length >= 0xff00) throw new Error('AES-CCM: AAD too long for this implementation');
  const encoded = new Uint8Array(Math.ceil((2 + aad.length) / 16) * 16);
  encoded[0] = (aad.length >> 8) & 0xff;
  encoded[1] = aad.length & 0xff;
  encoded.set(aad, 2);
  const out = new Uint8Array(16 + encoded.length);
  out.set(b0);
  out.set(encoded, 16);
  return out;
}

function cbcMac(aes: BlockEncrypt, nonce: Bytes, aad: Bytes, data: Bytes, tagLength: number): Bytes {
  const header = formatHeader(nonce, aad, data.length, tagLength);
  const padded = new Uint8Array(header.length + Math.ceil(data.length / 16) * 16);
  padded.set(header);
  padded.set(data, header.length);
  let y: Bytes = new Uint8Array(16);
  for (let i = 0; i < padded.length; i += 16) y = aes(xorBytes(y, padded.subarray(i, i + 16)));
  return y;
}

/** CTR transform with counters starting at 1; returns the output and S0 = AES(A0). */
function ctr(aes: BlockEncrypt, nonce: Bytes, input: Bytes): { output: Bytes; s0: Bytes } {
  const l = 15 - nonce.length;
  const a = new Uint8Array(16);
  a[0] = l - 1;
  a.set(nonce, 1);
  const s0 = aes(a.slice());
  const output = new Uint8Array(input.length);
  for (let block = 0, counter = 1; block * 16 < input.length; block++, counter++) {
    const ai = a.slice();
    let c = counter;
    for (let j = 0; j < l; j++) {
      ai[15 - j] = c & 0xff;
      c = Math.floor(c / 256);
    }
    const stream = aes(ai);
    for (let k = 0; k < 16 && block * 16 + k < input.length; k++) output[block * 16 + k] = input[block * 16 + k]! ^ stream[k]!;
  }
  return { output, s0 };
}

function constantTimeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function ccmEncrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, tagLength = 4, aad: Bytes = new Uint8Array(0)): { ciphertext: Bytes; tag: Bytes } {
  checkParameters(nonce, tagLength, plaintext.length);
  const aes = blockEncryptor(key);
  const mac = cbcMac(aes, nonce, aad, plaintext, tagLength);
  const { output, s0 } = ctr(aes, nonce, plaintext);
  return { ciphertext: output, tag: xorBytes(mac.subarray(0, tagLength), s0.subarray(0, tagLength)) };
}

/** Verifies the tag and returns the plaintext, or throws `CcmAuthError`. */
export function ccmDecrypt(key: Bytes, nonce: Bytes, ciphertext: Bytes, tag: Bytes, aad: Bytes = new Uint8Array(0)): Bytes {
  checkParameters(nonce, tag.length, ciphertext.length);
  const aes = blockEncryptor(key);
  const { output, s0 } = ctr(aes, nonce, ciphertext);
  const mac = cbcMac(aes, nonce, aad, output, tag.length);
  if (!constantTimeEqual(xorBytes(mac.subarray(0, tag.length), s0.subarray(0, tag.length)), tag)) throw new CcmAuthError();
  return output;
}
