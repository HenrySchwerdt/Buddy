/**
 * Bridge crypto of the Insight protocol (port of InsightKit/Protocol/BridgeCrypto.swift):
 * the section 3 envelope (AES-256-GCM, per-direction strictly increasing counters), the
 * section 4 key derivation (HKDF-SHA256), the pairing commitment, the 6-digit confirmation
 * code (SAS) and the confirmation / session MACs.
 *
 * Keys, nonces and ciphertext never leave this module except as return values; nothing here logs.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { constantTimeEqual, secureRandom, utf8Encode, type RandomSource } from './bytes';

export const DIRECTION_PHONE_TO_BRIDGE = 0x01;
export const DIRECTION_BRIDGE_TO_PHONE = 0x02;
export type Direction = typeof DIRECTION_PHONE_TO_BRIDGE | typeof DIRECTION_BRIDGE_TO_PHONE;

export const ENVELOPE_PLAINTEXT_HANDSHAKE = 0x01;
export const ENVELOPE_ENCRYPTED = 0x02;
const TAG_SIZE = 16;
const HEADER_SIZE = 9; // type + counter
/** Counters beyond 2^53 cannot be represented; the peer never gets near. */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export type EnvelopeFault = 'malformed' | 'replay' | 'authentication' | 'exhausted';

export class EnvelopeError extends Error {
  constructor(readonly fault: EnvelopeFault) {
    super(`Insight envelope rejected (${fault})`);
    this.name = 'EnvelopeError';
  }
}

const counterBytes = (counter: number): Bytes => {
  const out = new Uint8Array(8);
  const hi = Math.floor(counter / 0x1_0000_0000);
  const lo = counter >>> 0;
  out[0] = (hi >>> 24) & 0xff;
  out[1] = (hi >>> 16) & 0xff;
  out[2] = (hi >>> 8) & 0xff;
  out[3] = hi & 0xff;
  out[4] = (lo >>> 24) & 0xff;
  out[5] = (lo >>> 16) & 0xff;
  out[6] = (lo >>> 8) & 0xff;
  out[7] = lo & 0xff;
  return out;
};

const readCounter = (b: Bytes, offset: number): number | null => {
  const hi = ((b[offset]! << 24) | (b[offset + 1]! << 16) | (b[offset + 2]! << 8) | b[offset + 3]!) >>> 0;
  const lo = ((b[offset + 4]! << 24) | (b[offset + 5]! << 16) | (b[offset + 6]! << 8) | b[offset + 7]!) >>> 0;
  if (hi > 0x1fffff) return null;
  return hi * 0x1_0000_0000 + lo;
};

/** GCM nonce: direction byte || 0x000000 || counter (uint64 BE). */
export function gcmNonce(direction: Direction, counter: number): Bytes {
  return concatBytes(new Uint8Array([direction, 0, 0, 0]), counterBytes(counter));
}

const opposite = (d: Direction): Direction => (d === DIRECTION_PHONE_TO_BRIDGE ? DIRECTION_BRIDGE_TO_PHONE : DIRECTION_PHONE_TO_BRIDGE);

/** Section 3 envelope codec. Sending and receiving counters are tracked per session. */
export class EnvelopeCodec {
  private sendCounter: number;
  private lastReceived: number;

  /** `start` is for interoperability tests only (counters normally start at 1). */
  constructor(
    private readonly key: Bytes,
    private readonly sendDirection: Direction = DIRECTION_PHONE_TO_BRIDGE,
    start: { readonly sendCounter?: number; readonly lastReceivedCounter?: number } = {},
  ) {
    if (key.length !== 32) throw new Error('Insight: session key must be 32 bytes');
    this.sendCounter = start.sendCounter ?? 0;
    this.lastReceived = start.lastReceivedCounter ?? 0;
  }

  get lastSentCounter(): number {
    return this.sendCounter;
  }

  /** Encrypts `plaintext` and returns the complete envelope bytes. */
  seal(plaintext: Bytes): Bytes {
    const next = this.sendCounter + 1;
    if (next > MAX_COUNTER) throw new EnvelopeError('exhausted');
    const header = concatBytes(new Uint8Array([ENVELOPE_ENCRYPTED]), counterBytes(next));
    const sealed = gcm(this.key, gcmNonce(this.sendDirection, next), header).encrypt(plaintext);
    this.sendCounter = next;
    return concatBytes(header, sealed);
  }

  /** Verifies and decrypts an incoming envelope. Replays and tampering throw. */
  open(envelope: Bytes): Bytes {
    if (envelope.length < HEADER_SIZE + TAG_SIZE || envelope[0] !== ENVELOPE_ENCRYPTED) throw new EnvelopeError('malformed');
    const counter = readCounter(envelope, 1);
    if (counter === null) throw new EnvelopeError('malformed');
    if (counter <= this.lastReceived) throw new EnvelopeError('replay');
    let plain: Bytes;
    try {
      plain = gcm(this.key, gcmNonce(opposite(this.sendDirection), counter), envelope.slice(0, HEADER_SIZE)).decrypt(envelope.slice(HEADER_SIZE));
    } catch {
      throw new EnvelopeError('authentication');
    }
    this.lastReceived = counter; // only advanced after a valid tag
    return plain;
  }
}

export const isEncryptedEnvelope = (e: Bytes): boolean => e[0] === ENVELOPE_ENCRYPTED;

/** Plaintext handshake envelope: 0x01 || UTF-8 JSON. */
export const handshakeEnvelope = (json: Bytes): Bytes => concatBytes(new Uint8Array([ENVELOPE_PLAINTEXT_HANDSHAKE]), json);

/** The JSON body of a plaintext handshake envelope, `null` if it is not one. */
export const handshakeBody = (envelope: Bytes): Bytes | null => (envelope[0] === ENVELOPE_PLAINTEXT_HANDSHAKE && envelope.length > 1 ? envelope.slice(1) : null);

// ── key derivation (section 4) ───────────────────────────────────────────────

const LTK_INFO = utf8Encode('InsightBridge LTK v1');
const SK_INFO = utf8Encode('InsightBridge SK v1');
const COMMIT_PREFIX = utf8Encode('InsightBridge commit v2');

/** LTK = HKDF-SHA256(ikm = ECDH x-coordinate, salt = nonceI || nonceB, info = "InsightBridge LTK v1", 32) */
export const longTermKey = (sharedSecretX: Bytes, nonceI: Bytes, nonceB: Bytes): Bytes => hkdf(sha256, sharedSecretX, concatBytes(nonceI, nonceB), LTK_INFO, 32);

/** SK = HKDF-SHA256(ikm = LTK, salt = nonceI || nonceB, info = "InsightBridge SK v1", 32) */
export const sessionKey = (ltk: Bytes, nonceI: Bytes, nonceB: Bytes): Bytes => hkdf(sha256, ltk, concatBytes(nonceI, nonceB), SK_INFO, 32);

/** v2 pairing commitment: SHA-256("InsightBridge commit v2" || pubI (raw 65 B X9.63) || nonceI) */
export const commitment = (publicKey: Bytes, nonce: Bytes): Bytes => sha256(concatBytes(COMMIT_PREFIX, publicKey, nonce));

const mac = (ltk: Bytes, message: Bytes): Bytes => hmac(sha256, ltk, message);

/** 6-digit confirmation code = uint32BE(HMAC-SHA256(LTK, "SAS")[0..3]) mod 1_000_000, zero padded. */
export function confirmationCode(ltk: Bytes): string {
  const m = mac(ltk, utf8Encode('SAS'));
  const value = ((m[0]! << 24) | (m[1]! << 16) | (m[2]! << 8) | m[3]!) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}

export const confirmMacPhone = (ltk: Bytes): Bytes => mac(ltk, utf8Encode('confirm-i'));
export const confirmMacBridge = (ltk: Bytes): Bytes => mac(ltk, utf8Encode('confirm-b'));

/** HMAC-SHA256(LTK, "session" || nonceI || nonceB) */
export const sessionMac = (ltk: Bytes, nonceI: Bytes, nonceB: Bytes): Bytes => mac(ltk, concatBytes(utf8Encode('session'), nonceI, nonceB));

export const verifyMac = (received: Bytes, expected: Bytes): boolean => constantTimeEqual(received, expected);

// ── ephemeral ECDH (P-256) ───────────────────────────────────────────────────

export interface PairingKeyPair {
  readonly privateKey: Bytes;
  /** 65-byte X9.63 uncompressed point */
  readonly publicKey: Bytes;
}

export function generatePairingKeyPair(random: RandomSource = secureRandom): PairingKeyPair {
  const privateKey = p256.utils.randomSecretKey(random(48));
  return { privateKey, publicKey: p256.getPublicKey(privateKey, false) };
}

export const publicKeyFromPrivate = (privateKey: Bytes): Bytes => p256.getPublicKey(privateKey, false);

/** ECDH x-coordinate (32 bytes); throws if `peerPublicKey` is not a valid P-256 point. */
export function ecdhSharedSecret(privateKey: Bytes, peerPublicKey: Bytes): Bytes {
  if (peerPublicKey.length !== 65 || peerPublicKey[0] !== 0x04) throw new Error('Insight: bridge public key is not an X9.63 point');
  return p256.getSharedSecret(privateKey, peerPublicKey, false).slice(1, 33);
}
