/**
 * TypeScript port of SyaiBLEAuthV2.swift from SyaiKit (MIT, © 2026 Nightscout Foundation).
 *
 * Handshake: the device proves it holds the 96-byte key group (SHA-256 signature over one of its
 * six 16-byte keys, the MAC, its P-256 public key and a time field), the app answers the same
 * way with an ephemeral P-256 key, and the AES-128 session key is the odd-indexed bytes of the
 * ECDH shared secret X (no KDF). Key bytes are never logged.
 */
import type { Bytes } from '@buddy/core';
import { concatBytes, writeU16le } from '@buddy/core';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesEqual } from './bytes';
import { CHAR } from './constants';
import { SyaiFailure } from './errors';
import type { SyaiGatt } from './gatt';

export const KEY_GROUP_BYTES = 96;
export const AUTH_BLOB_SIZE = 68;
const COORD = 32;
const TIME_WIDTH = 3;

export type RandomSource = (length: number) => Bytes;
export const systemRandom: RandomSource = (n) => randomBytes(n);

export interface DeviceParams {
  readonly idx: number;
  readonly time: Bytes;
  readonly pubX: Bytes;
  readonly pubY: Bytes;
}

/** AES-128 session key: odd-indexed bytes of the 32-byte shared secret X. */
export function sessionKeyFromSharedSecretX(x: Bytes): Bytes {
  const out = new Uint8Array(x.length >> 1);
  for (let i = 1, o = 0; i < x.length; i += 2) out[o++] = x[i]!;
  return out;
}

export function keyAt(idx: number, keyGroup: Bytes): Bytes {
  if (keyGroup.length !== KEY_GROUP_BYTES) throw new SyaiFailure('noKeyGroup', `auth: key group is ${keyGroup.length} bytes, expected ${KEY_GROUP_BYTES} (6x16)`);
  const start = (idx % 6) * 16;
  return keyGroup.slice(start, start + 16);
}

/** `"001122334455"` (or with `:`/`-`) to 6 bytes. */
export function macBytes(mac: string): Bytes {
  const clean = mac.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return new Uint8Array(out);
}

/** `SHA256(cx | MAC | pubX | pubY | currentTime)`; `cx` first. */
export function appSignature(cx: Bytes, mac: Bytes, pubX: Bytes, pubY: Bytes, currentTime: Bytes): Bytes {
  return sha256(concatBytes(cx, mac, pubX, pubY, currentTime));
}

/**
 * The authFlag preimage encodes currentTime as `00 | wire[0] | wire[1]`; using the raw 4-byte
 * read gets the session kicked at the 60 s mark. A genuine 3-byte read passes through.
 */
export function currentTimeDigestEncoding(wireRead: Bytes): Bytes {
  if (wireRead.length === 3) return wireRead.slice();
  return new Uint8Array([0x00, wireRead[0] ?? 0, wireRead[1] ?? 0]);
}

/** App to device blob (68 B): `idx(2 LE) | index(2 LE) | pubX(32) | pubY(32)`. */
export function appParamBlob(index: number, idx: number, pubX: Bytes, pubY: Bytes): Bytes {
  return concatBytes(writeU16le(idx), writeU16le(index), pubX, pubY);
}

/** Device to app blob (68 B): `idx(1) | time(3) | pubX(32) | pubY(32)`. */
export function parseDeviceParams(blob: Bytes): DeviceParams {
  if (blob.length < AUTH_BLOB_SIZE) throw new SyaiFailure('authFailed', `auth: device param blob too short (${blob.length} bytes)`);
  return {
    idx: blob[0]! % 6,
    time: blob.slice(1, 1 + TIME_WIDTH),
    pubX: blob.slice(4, 4 + COORD),
    pubY: blob.slice(4 + COORD, 4 + 2 * COORD),
  };
}

/** The device proved possession of the key group iff `sign == SHA256(key[idx] | MAC | pubX | pubY | time)`. */
export function verifyDeviceSignature(sign: Bytes, params: DeviceParams, mac: Bytes, keyGroup: Bytes): void {
  const expected = sha256(concatBytes(keyAt(params.idx, keyGroup), mac, params.pubX, params.pubY, params.time));
  if (!bytesEqual(expected, sign)) throw new SyaiFailure('authFailed', 'auth: device sign mismatch, peer does not hold the key group');
}

/** Runs the full handshake and returns the 16-byte AES-128 session key. */
export async function authenticate(gatt: SyaiGatt, mac: string, keyGroup: Bytes, random: RandomSource = systemRandom): Promise<Bytes> {
  const mac6 = macBytes(mac);

  // 1. Device half: read params + signature, verify (fatal on mismatch).
  const device = parseDeviceParams(await gatt.read(CHAR.authDev));
  verifyDeviceSignature(await gatt.read(CHAR.authFlag), device, mac6, keyGroup);

  // 2. App half: the currentTime counter feeds both the digest preimage and the authHost index.
  const currentTimeRaw = await gatt.read(CHAR.currentTime);
  const secretKey = p256.utils.randomSecretKey(random(48));
  const appPub = p256.getPublicKey(secretKey, false); // 0x04 | X | Y
  const pubX = appPub.slice(1, 1 + COORD);
  const pubY = appPub.slice(1 + COORD);
  const idxApp = random(1)[0]! % 6;
  const index = currentTimeRaw.length >= 2 ? currentTimeRaw[0]! | (currentTimeRaw[1]! << 8) : 0;
  await gatt.write(CHAR.authHost, appParamBlob(index, idxApp, pubX, pubY), true);
  const sig = appSignature(keyAt(idxApp, keyGroup), mac6, pubX, pubY, currentTimeDigestEncoding(currentTimeRaw));
  await gatt.write(CHAR.authFlag, sig, true);

  // 3. ECDH to the AES-128 session key.
  let shared: Bytes;
  try {
    shared = p256.getSharedSecret(secretKey, concatBytes(new Uint8Array([0x04]), device.pubX, device.pubY), false);
  } catch {
    throw new SyaiFailure('authFailed', 'auth: device P-256 public key invalid');
  }
  return sessionKeyFromSharedSecretX(shared.slice(1, 1 + COORD));
}
