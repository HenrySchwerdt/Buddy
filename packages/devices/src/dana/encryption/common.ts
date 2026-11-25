/**
 * TypeScript port of DanaKit/Encryption/DanaKitEncryption+Common.swift
 * from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit authors).
 *
 * All arithmetic is UInt8 with wrapping (`&+`, `&-`) in Swift; `u8()` reproduces that.
 * Swift functions mutate an `inout Data`; these return a new array instead.
 *
 * Operator precedence note: in Swift `|`, `^`, `&+` and `&-` share one precedence level and
 * associate left (`a | b ^ c` is `(a | b) ^ c`), unlike JavaScript. Every expression below is
 * fully parenthesised to the Swift meaning.
 */
import type { Bytes } from '@buddy/core';

export const u8 = (x: number): number => x & 0xff;
/** `((b >> 4) & 0xF) | ((b & 0xF) << 4)` — swaps the nibbles of a byte. */
export const swapNibbles = (b: number): number => ((b >> 4) & 0x0f) | ((b & 0x0f) << 4);

/**
 * `deviceName.utf8CString` — the UTF-8 bytes followed by a NUL terminator. The Swift code reads
 * indices 0…9, so the device name must be exactly 10 ASCII characters (validated by the driver);
 * missing bytes read as 0 instead of trapping.
 */
export function deviceNameBytes(deviceName: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 10; i++) out.push(i < deviceName.length ? deviceName.charCodeAt(i) & 0xff : 0);
  return out;
}
const nameByte = (deviceName: string, i: number): number => deviceNameBytes(deviceName)[i] ?? 0;

// exec_get_enc_packet_passkey(char*, Int, char*)
export function encodePacketPassKey(buffer: Bytes, passkeySecret: Bytes): Bytes {
  const out = buffer.slice();
  if (passkeySecret.length === 0) return out;

  for (let i = 0; i < out.length - 5; i++) {
    out[i + 3] = u8(out[i + 3]! ^ passkeySecret[(i + 1) % 2]!);
  }
  return out;
}

// exec_get_enc_passkey_sn(byte, char*)
export function encodePacketPassKeySerialNumber(value: number, deviceName: string): number {
  let tmp = 0;
  for (let i = 0; i < Math.min(10, deviceName.length); i++) {
    tmp = u8(tmp + nameByte(deviceName, i));
  }
  return u8(value ^ tmp);
}

// exec_get_enc_packet_password
export function encodePacketPassword(buffer: Bytes, passwordSecret: Bytes): Bytes {
  const out = buffer.slice();
  if (passwordSecret.length !== 2) return out;

  const tmp = u8(passwordSecret[0]! + passwordSecret[1]!);
  for (let i = 3; i < out.length - 2; i++) out[i] = u8(out[i]! ^ tmp);
  return out;
}

// exec_get_enc_packet_sn(char*, Int, char*)
export function encodePacketSerialNumber(buffer: Bytes, deviceName: string): Bytes {
  const n = deviceNameBytes(deviceName);
  const tmp = [u8(n[0]! + n[1]! + n[2]!), u8(n[3]! + n[4]! + n[5]! + n[6]! + n[7]!), u8(n[8]! + n[9]!)];

  const out = buffer.slice();
  for (let i = 0; i < out.length - 5; i++) {
    out[i + 3] = u8(out[i + 3]! ^ tmp[i % 3]!);
  }
  return out;
}

// exec_get_enc_packet_time(char*, Int, char*)
export function encodePacketTime(buffer: Bytes, timeSecret: Bytes): Bytes {
  // Swift: `timeSecret.reduce(0, +)` on UInt8 (would trap on overflow; the JNI original wraps)
  const tmp = timeSecret.reduce((s, b) => u8(s + b), 0);
  const out = buffer.slice();
  for (let i = 3; i < out.length - 2; i++) out[i] = u8(out[i]! ^ tmp);
  return out;
}

// exec_get_enc_pairingkey(int, int)
export function encodePairingKey(buffer: Bytes, pairingKey: Bytes, globalRandomSyncKey: number): { globalRandomSyncKey: number; buffer: Bytes } {
  const out = buffer.slice();
  const pk = (i: number) => pairingKey[i] ?? 0;
  let newRandomSyncKey = globalRandomSyncKey;

  for (let i = 0; i < out.length; i++) {
    let b = out[i]!;
    b = u8(b ^ pk(0));
    b = u8(b - newRandomSyncKey);
    b = swapNibbles(b);

    b = u8(b + pk(1));
    b = u8(b ^ pk(2));
    b = swapNibbles(b);

    b = u8(b - pk(3));
    b = u8(b ^ pk(4));
    b = swapNibbles(b);

    b = u8(b ^ pk(5));
    b = u8(b ^ newRandomSyncKey);

    out[i] = b;
    newRandomSyncKey = b;
  }

  // set global random sync key to newRandomSyncKey
  return { globalRandomSyncKey: newRandomSyncKey, buffer: out };
}

// exec_get_desc_pairingkey(char*, int)
export function getDescPairingKey(buffer: Bytes, pairingKey: Bytes, globalRandomSyncKey: number): { globalRandomSyncKey: number; buffer: Bytes } {
  // This is the reverse of encodePairingKey
  const out = buffer.slice();
  const pk = (i: number) => pairingKey[i] ?? 0;
  let newRandomSyncKey = globalRandomSyncKey;

  for (let i = 0; i < out.length; i++) {
    const tmp = out[i]!;
    let b = tmp;

    b = u8(b ^ newRandomSyncKey);
    b = u8(b ^ pk(5));

    b = swapNibbles(b);
    b = u8(b ^ pk(4));
    b = u8(b + pk(3));

    b = swapNibbles(b);
    b = u8(b ^ pk(2));
    b = u8(b - pk(1));
    b = u8(b ^ pk(0));

    b = swapNibbles(b);
    b = u8(b + newRandomSyncKey);

    out[i] = b;
    // set global random sync key to newRandomSyncKey
    newRandomSyncKey = tmp;
  }

  return { globalRandomSyncKey: newRandomSyncKey, buffer: out };
}

export function encryptionRandomSyncKey(randomSyncKey: number, randomPairingKey: Bytes): number {
  let tmp = 0;
  tmp = u8(swapNibbles(randomSyncKey) + randomPairingKey[0]!);
  tmp = u8(swapNibbles(tmp) ^ randomPairingKey[1]!);
  return u8(swapNibbles(tmp) - randomPairingKey[2]!);
}

export function decryptionRandomSyncKey(randomSyncKey: number, randomPairingKey: Bytes): number {
  let tmp = 0;
  tmp = u8(swapNibbles(u8(randomSyncKey + randomPairingKey[2]!)) ^ randomPairingKey[1]!);
  tmp = u8(swapNibbles(tmp) - randomPairingKey[0]!);
  return swapNibbles(tmp);
}

export function initialRandomSyncKey(pairingKey: Bytes): number {
  const pk = (i: number) => pairingKey[i]!;
  let tmp = 0;
  // Swift: (((p0 &+ p1) >> 4) | (((p0 &+ p1) & 0xF) << 4) ^ p2) &- p3  ==  ((swap(p0+p1)) ^ p2) - p3
  tmp = u8((swapNibbles(u8(pk(0) + pk(1))) ^ pk(2)) - pk(3));
  tmp = u8(swapNibbles(tmp) ^ pk(4));
  return u8(swapNibbles(tmp) ^ pk(5));
}
