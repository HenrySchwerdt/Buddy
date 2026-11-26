/**
 * TypeScript port of SyaiSecureChannel.swift and SyaiBackend.swift (request signatures) from
 * SyaiKit (MIT, © 2026 Nightscout Foundation): the AES-256-GCM envelope that wraps every
 * api.syai.com call, negotiated with an ephemeral P-256 key exchange + HKDF-SHA256.
 *
 * Session-key split: GCM key = HKDF[0:32], HMAC key = HKDF[32:64]. Keys are never logged.
 */
import type { Bytes } from '@buddy/core';
import { concatBytes } from '@buddy/core';
import { ecb, gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { md5 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from './bytes';
import type { RandomSource } from './ble-auth';
import { SyaiFailure } from './errors';

export const GCM_NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;

/** Hardcoded request-signing key baked into the official app binary; not a per-account secret. */
export const DEVICE_SIGN_KEY = 'dy7234hbnrnfh7q89eru8ybfn899';
/** AES-256 key for the login `encryptInfo`. */
export const LOGIN_AES_KEY = 'miH5ngQ7z4NZU3JgZFq87Gg6v1Y7YJm9';

const toHex = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export interface ChannelSession {
  readonly secretId: string;
  readonly deviceId: string;
  readonly gcmKey: Bytes;
  readonly hmacKey: Bytes;
  /** ms since epoch. */
  readonly expireTime: number;
}

export interface Envelope {
  readonly text: string;
  readonly mac: string;
  readonly nonce: string;
  readonly signature: string;
  readonly secretId: string;
  readonly seq: number;
  readonly nonceId: string;
  readonly timeNow: number;
  readonly userId: string;
}

export const sessionAad = (s: Pick<ChannelSession, 'deviceId' | 'secretId'>): Bytes => utf8Encode(`${s.deviceId}|${s.secretId}`);

/** `/security/exchangeKey` request: ephemeral keypair + plaintext POST body. */
export function makeExchangeRequest(deviceId: string, now: number, random: RandomSource) {
  const secretKey = p256.utils.randomSecretKey(random(48));
  const pub = p256.getPublicKey(secretKey, false);
  const b64x = base64Encode(pub.slice(1, 33));
  const b64y = base64Encode(pub.slice(33, 65));
  const clientSignature = toHex(sha256(utf8Encode(deviceId + b64x + b64y + String(now))));
  return { secretKey, body: { clientPubKeyX: b64x, clientPubKeyY: b64y, clientTimestamp: now, clientSignature } };
}

/** HKDF-SHA256, 64 B out: salt = secretId, info = `{deviceId}#{expireTime}#{secretId}`. */
export function deriveChannelKeys(ikm: Bytes, secretId: string, deviceId: string, expireTime: number): { gcmKey: Bytes; hmacKey: Bytes } {
  const okm = hkdf(sha256, ikm, utf8Encode(secretId), utf8Encode(`${deviceId}#${expireTime}#${secretId}`), 2 * KEY_LENGTH);
  return { gcmKey: okm.slice(0, KEY_LENGTH), hmacKey: okm.slice(KEY_LENGTH) };
}

const asInt = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
};

/** Derives the session from the exchangeKey response (`serverPubKeyX`/`Y`, `secretId`, `expireTime`). */
export function deriveSession(secretKey: Bytes, response: Readonly<Record<string, unknown>>, deviceId: string): ChannelSession {
  const x = typeof response.serverPubKeyX === 'string' ? base64Decode(response.serverPubKeyX) : null;
  const y = typeof response.serverPubKeyY === 'string' ? base64Decode(response.serverPubKeyY) : null;
  if (!x || !y) throw new SyaiFailure('network', "secure channel: handshake response missing 'serverPubKeyX/Y'");
  const secretId = (typeof response.secretId === 'string' && response.secretId) || (typeof response.cipherSecretId === 'string' && response.cipherSecretId) || '';
  if (!secretId) throw new SyaiFailure('network', "secure channel: handshake response missing 'secretId'");
  const expireTime = asInt(response.expireTime) ?? asInt(response.expiresAt) ?? 0;
  let shared: Bytes;
  try {
    shared = p256.getSharedSecret(secretKey, concatBytes(new Uint8Array([0x04]), x, y), false);
  } catch {
    throw new SyaiFailure('network', "secure channel: server public key wasn't a valid P-256 point");
  }
  return { secretId, deviceId, expireTime, ...deriveChannelKeys(shared.slice(1, 33), secretId, deviceId, expireTime) };
}

/** Encrypts a JSON body under the session; `seq` is supplied by the caller. */
export function encryptRequest(session: ChannelSession, seq: number, bodyJSON: string, now: number, random: RandomSource): Envelope {
  const nonce = random(GCM_NONCE_LENGTH);
  const sealed = gcm(session.gcmKey, nonce, sessionAad(session)).encrypt(utf8Encode(bodyJSON));
  const text = base64Encode(sealed.slice(0, sealed.length - TAG_LENGTH));
  const mac = base64Encode(sealed.slice(sealed.length - TAG_LENGTH));
  const r = random(2);
  const nonceId = String(now * 4096 + (((r[0]! << 8) | r[1]!) & 0xfff)); // (millis << 12) | 12 random bits
  const signature = base64Encode(hmac(sha256, session.hmacKey, utf8Encode(`${nonceId}${seq}${now}${text}`)));
  return { text, mac, nonce: base64Encode(nonce), signature, secretId: session.secretId, seq, nonceId, timeNow: now, userId: session.deviceId };
}

/** Decrypts a response envelope (`cipherText`/`cipherMac`/`cipherNonce`). */
export function decryptResponse(session: ChannelSession, textB64: string, macB64: string, nonceB64: string): string {
  const ct = base64Decode(textB64);
  const tag = base64Decode(macB64);
  const nonce = base64Decode(nonceB64);
  if (!ct || !tag || !nonce) throw new SyaiFailure('network', 'secure channel: response cipher fields not valid base64');
  try {
    return utf8Decode(gcm(session.gcmKey, nonce, sessionAad(session)).decrypt(concatBytes(ct, tag)));
  } catch {
    throw new SyaiFailure('network', 'secure channel: GCM open failed');
  }
}

// ── request signatures (keyed MD5) ─────────────────────────────────────────────

const md5Hex = (preimage: string): string => toHex(md5(utf8Encode(preimage)));

export interface Identity {
  readonly appName: string;
  readonly deviceId: string;
}

/** `signAuthInfo`: md5(signKey + appName + deviceId + mac + timestamp + signKey). */
export const signAuthInfo = (id: Identity, mac: string, ts: string): string => md5Hex(DEVICE_SIGN_KEY + id.appName + id.deviceId + mac + ts + DEVICE_SIGN_KEY);
/** `signApiToken`: md5(appName + deviceId + timestamp + signKey). */
export const signApiToken = (id: Identity, ts: string): string => md5Hex(id.appName + id.deviceId + ts + DEVICE_SIGN_KEY);
/** `signLogin`: md5(appName + deviceId + timestamp + apiToken + email + password + signKey). */
export const signLogin = (id: Identity, ts: string, apiToken: string, email: string, password: string): string =>
  md5Hex(id.appName + id.deviceId + ts + apiToken + email + password + DEVICE_SIGN_KEY);

/** Login `encryptInfo` = base64(AES-256-ECB/PKCS7(compact JSON {email,password})). */
export function loginEncryptInfo(email: string, password: string): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return base64Encode(ecb(utf8Encode(LOGIN_AES_KEY)).encrypt(utf8Encode(`{"email":"${esc(email)}","password":"${esc(password)}"}`)));
}
