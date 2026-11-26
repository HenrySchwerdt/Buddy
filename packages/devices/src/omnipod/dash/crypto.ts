/**
 * Crypto primitives of the DASH protocol on top of `@noble/ciphers` and `@noble/curves`:
 * AES-CMAC, AES-ECB single blocks, AES-CCM (8 byte tag, 13 byte nonce) and X25519.
 * Replaces the CryptoSwift / CryptoKit calls of OmnipodKit (MIT License, (c) LoopKit Authors).
 * Keys are never logged.
 */
import { cmac, ctr, ecb } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { concatBytes, type Bytes } from '@buddy/core';
import { xorBytes } from '../common/bytes';
import { OmnipodError } from './errors';

export const aesCmac = (key: Bytes, data: Bytes): Bytes => cmac(data, key);

/** AES-ECB encryption of whole 16 byte blocks, no padding. */
export const aesEcbEncrypt = (key: Bytes, blocks: Bytes): Bytes => ecb(key, { disablePadding: true }).encrypt(blocks);

export const x25519PublicKey = (privateKey: Bytes): Bytes => x25519.getPublicKey(privateKey);
export const x25519SharedSecret = (privateKey: Bytes, publicKey: Bytes): Bytes => x25519.getSharedSecret(privateKey, publicKey);

const BLOCK = 16;

function padTo16(b: Bytes): Bytes {
  const rem = b.length % BLOCK;
  return rem === 0 ? b : concatBytes(b, new Uint8Array(BLOCK - rem));
}

function lengthBytes(value: number, size: number): Bytes {
  const out = new Uint8Array(size);
  for (let i = size - 1, v = value; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff;
  return out;
}

/** CBC-MAC part of CCM (RFC 3610): returns the unencrypted tag T (first `tagLength` bytes). */
function ccmTag(key: Bytes, nonce: Bytes, aad: Bytes, message: Bytes, tagLength: number): Bytes {
  const L = 15 - nonce.length;
  const flags = (aad.length > 0 ? 0x40 : 0) | (((tagLength - 2) / 2) << 3) | (L - 1);
  const b0 = concatBytes(new Uint8Array([flags]), nonce, lengthBytes(message.length, L));
  const aadBlock = aad.length > 0 ? padTo16(concatBytes(lengthBytes(aad.length, 2), aad)) : new Uint8Array(0);
  const input = concatBytes(b0, aadBlock, padTo16(message));
  let x: Bytes = new Uint8Array(BLOCK);
  // noble's one-shot ciphers refuse a second encrypt() call, so every block gets a fresh instance
  for (let o = 0; o < input.length; o += BLOCK) x = aesEcbEncrypt(key, xorBytes(x, input.subarray(o, o + BLOCK)));
  return x.slice(0, tagLength);
}

function ccmCtrBlock(nonce: Bytes, counter: number): Bytes {
  const L = 15 - nonce.length;
  return concatBytes(new Uint8Array([L - 1]), nonce, lengthBytes(counter, L));
}

/** AES-CCM encryption. Returns ciphertext followed by the authentication tag. */
export function aesCcmEncrypt(key: Bytes, nonce: Bytes, aad: Bytes, plaintext: Bytes, tagLength = 8): Bytes {
  if (nonce.length !== 13) throw new OmnipodError('protocol', 'CCM nonce must be 13 bytes');
  const tag = ccmTag(key, nonce, aad, plaintext, tagLength);
  const s0 = aesEcbEncrypt(key, ccmCtrBlock(nonce, 0));
  const body = plaintext.length ? ctr(key, ccmCtrBlock(nonce, 1)).encrypt(plaintext) : new Uint8Array(0);
  return concatBytes(body, xorBytes(tag, s0.subarray(0, tagLength)));
}

/** AES-CCM decryption of `ciphertext || tag`; throws when the tag does not verify. */
export function aesCcmDecrypt(key: Bytes, nonce: Bytes, aad: Bytes, input: Bytes, tagLength = 8): Bytes {
  if (nonce.length !== 13) throw new OmnipodError('protocol', 'CCM nonce must be 13 bytes');
  if (input.length < tagLength) throw new OmnipodError('protocol', 'Encrypted payload too short');
  const body = input.subarray(0, input.length - tagLength);
  const receivedTag = input.subarray(input.length - tagLength);
  const plaintext = body.length ? ctr(key, ccmCtrBlock(nonce, 1)).decrypt(body) : new Uint8Array(0);
  const s0 = aesEcbEncrypt(key, ccmCtrBlock(nonce, 0));
  const expected = xorBytes(ccmTag(key, nonce, aad, plaintext, tagLength), s0.subarray(0, tagLength));
  let diff = 0;
  for (let i = 0; i < tagLength; i++) diff |= expected[i]! ^ receivedTag[i]!;
  if (diff !== 0) throw new OmnipodError('protocol', 'Authentication tag mismatch');
  return plaintext;
}
