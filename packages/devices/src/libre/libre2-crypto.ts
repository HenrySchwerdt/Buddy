/**
 * TypeScript port of `LibreSensor/SensorContents/PreLibre2.swift` (`enum Libre2`) from
 * loopandlearn/LibreTransmitter (MIT, (c) the LibreTransmitter / LibreDirect / xDrip authors).
 *
 * Libre 2 FRAM and BLE de-obfuscation (xor key stream from a small 16-bit block function),
 * the BLE streaming unlock payload, and the 44-byte BLE packet parser.
 *
 * All sensor UIDs are in the byte order the Swift code uses: the CoreNFC tag identifier
 * reversed, i.e. ending in `07 e0` (example: `9d 81 c2 00 00 a4 07 e0`).
 */
import type { Bytes } from '@buddy/core';
import { byteSwap16, hasValidCrc16InLastTwoBytes, libreCrc16 } from './crc';
import { createMeasurement, type Measurement } from './measurement';
import { readBits } from './bits';
import type { SensorType } from './sensor-type';

const KEY = [0xa0c5, 0x6860, 0x0000, 0x14c6] as const;

const u16 = (high: number, low: number): number => ((high << 8) + low) & 0xffff;
const at = (b: ArrayLike<number>, i: number): number => {
  const v = b[i];
  if (v === undefined) throw new RangeError(`Libre2: byte index ${i} out of range (length ${b.length})`);
  return v;
};

export class Libre2DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Libre2DecryptionError';
  }
}

/** `Libre2.processCrypto(input:)`. Input and output are four 16-bit words. */
export function processCrypto(input: readonly number[]): [number, number, number, number] {
  const op = (value: number): number => {
    let res = value >>> 2;
    if (value & 1) res ^= KEY[1];
    if (value & 2) res ^= KEY[0];
    return res;
  };
  const i0 = at(input, 0), i1 = at(input, 1), i2 = at(input, 2), i3 = at(input, 3);
  const r0 = op(i0) ^ i3;
  const r1 = op(r0) ^ i2;
  const r2 = op(r1) ^ i1;
  const r3 = op(r2) ^ i0;
  const r4 = op(r3);
  const r5 = op(r4 ^ r0);
  const r6 = op(r5 ^ r1);
  const r7 = op(r6 ^ r2);
  return [r3 ^ r7, r2 ^ r6, r1 ^ r5, r0 ^ r4];
}

/** `Libre2.prepareVariables(id:x:y:)` (identical to the `sensorUID:x:y:` overload). */
export function prepareVariables(id: ArrayLike<number>, x: number, y: number): [number, number, number, number] {
  const s1 = (u16(at(id, 5), at(id, 4)) + x + y) & 0xffff;
  const s2 = (u16(at(id, 3), at(id, 2)) + KEY[2]) & 0xffff;
  const s3 = (u16(at(id, 1), at(id, 0)) + x * 2) & 0xffff;
  const s4 = 0x241a ^ KEY[3];
  return [s1, s2, s3, s4];
}

/** `Libre2.prepareVariables(sensorUID:i1:i2:i3:i4:)`. */
export function prepareVariables4(uid: ArrayLike<number>, i1: number, i2: number, i3: number, i4: number): [number, number, number, number] {
  const s1 = (u16(at(uid, 5), at(uid, 4)) + i1) & 0xffff;
  const s2 = (u16(at(uid, 3), at(uid, 2)) + i2) & 0xffff;
  const s3 = (u16(at(uid, 1), at(uid, 0)) + i3 + KEY[2]) & 0xffff;
  const s4 = (i4 + KEY[3]) & 0xffff;
  return [s1, s2, s3, s4];
}

/** `Libre2.usefulFunction(id:x:y:)`: 4 bytes derived from the UID, used by NFC commands. */
export function usefulFunction(id: ArrayLike<number>, x: number, y: number): Bytes {
  const blockKey = processCrypto(prepareVariables(id, x, y));
  const r1 = blockKey[0] ^ 0x4163;
  const r2 = blockKey[1] ^ 0x4344;
  return new Uint8Array([r1 & 0xff, (r1 >>> 8) & 0xff, r2 & 0xff, (r2 >>> 8) & 0xff]);
}

const wordsToBytes = (words: readonly number[]): number[] => words.flatMap((w) => [w & 0xff, (w >>> 8) & 0xff]);

/**
 * `Libre2.decryptFRAM(type:id:info:data:)`: decrypts 43 blocks (344 bytes) of Libre 2 /
 * Libre US 14-day FRAM. `info` is the 6-byte patch info returned by NFC command 0xA1.
 */
export function decryptFram(type: SensorType, id: ArrayLike<number>, info: ArrayLike<number>, data: ArrayLike<number>): Bytes {
  if (type !== 'Libre 2' && type !== 'Libre US 14d') throw new Libre2DecryptionError('Unsupported sensor type');
  if (data.length < 43 * 8) throw new Libre2DecryptionError(`FRAM too short (${data.length} bytes)`);
  const getArg = (block: number): number => {
    if (type === 'Libre US 14d') {
      if (block < 3 || block >= 40) return 0xcadc; // header and footer use a fixed value
      return u16(at(info, 5), at(info, 4));
    }
    return u16(at(info, 5), at(info, 4)) ^ 0x44;
  };
  const result = new Uint8Array(43 * 8);
  for (let i = 0; i < 43; i++) {
    const key = wordsToBytes(processCrypto(prepareVariables(id, i, getArg(i))));
    for (let j = 0; j < 8; j++) result[i * 8 + j] = at(data, i * 8 + j) ^ key[j]!;
  }
  return result;
}

/** XORs the BLE payload (everything after the two clear-text header bytes) with the key stream. */
export function xorBlePayload(id: ArrayLike<number>, data: ArrayLike<number>): Bytes {
  if (data.length < 2 || data.length - 2 > 64) throw new Libre2DecryptionError(`Unexpected BLE packet length ${data.length}`);
  const d = usefulFunction(id, 0x1b, 0x1b6a);
  const x = (u16(d[1]!, d[0]!) ^ u16(d[3]!, d[2]!)) | 0x63;
  const y = u16(at(data, 1), at(data, 0)) ^ 0x63;
  const key: number[] = [];
  let initialKey = processCrypto(prepareVariables(id, x, y));
  for (let i = 0; i < 8; i++) {
    key.push(...wordsToBytes(initialKey));
    initialKey = processCrypto(initialKey);
  }
  const out = new Uint8Array(data.length - 2);
  for (let i = 0; i < out.length; i++) out[i] = at(data, i + 2) ^ key[i]!;
  return out;
}

/** `Libre2.decryptBLE(id:data:)`: 46 encrypted bytes in, 44 decrypted bytes out (CRC checked). */
export function decryptBle(id: ArrayLike<number>, data: ArrayLike<number>): Bytes {
  const result = xorBlePayload(id, data);
  if (!hasValidCrc16InLastTwoBytes(result)) throw new Libre2DecryptionError('BLE data decrytion failed');
  return result;
}

/** `Libre2.activateParameters(id:)`. */
export function activateParameters(id: ArrayLike<number>): Bytes {
  const d = usefulFunction(id, 0x1b, 0x1b6a);
  return new Uint8Array([0x1b, d[0]!, d[1]!, d[2]!, d[3]!]);
}

/** `Libre2.streamingUnlockPayload(sensorUID:info:enableTime:unlockCount:)`: 12 bytes written to 0xF001. */
export function streamingUnlockPayload(sensorUid: ArrayLike<number>, info: ArrayLike<number>, enableTime: number, unlockCount: number): Bytes {
  const time = (enableTime + (unlockCount & 0xffff)) >>> 0;
  const b = [time & 0xff, (time >>> 8) & 0xff, (time >>> 16) & 0xff, (time >>> 24) & 0xff] as const;

  const ad = usefulFunction(sensorUid, 0x1b, 0x1b6a);
  const ed = usefulFunction(sensorUid, 0x1e, (enableTime & 0xffff) ^ u16(at(info, 5), at(info, 4)));

  const t11 = u16(ed[1]!, ed[0]!) ^ u16(b[3], b[2]);
  const t12 = u16(ad[1]!, ad[0]!);
  const t13 = u16(ed[3]!, ed[2]!) ^ u16(b[1], b[0]);
  const t14 = u16(ad[3]!, ad[2]!);
  const t2 = processCrypto(prepareVariables4(sensorUid, t11, t12, t13, t14));

  // The Swift file's private crc16() returns `crc.byteSwapped`, and the call site swaps again.
  const crc = (bytes: number[]): number => byteSwap16(libreCrc16(bytes, 0xffff));
  const t31 = crc([0xc1, 0xc4, 0xc3, 0xc0, 0xd4, 0xe1, 0xe7, 0xba, t2[0] & 0xff, (t2[0] >>> 8) & 0xff]);
  const t32 = crc(wordsToBytes([t2[1], t2[2], t2[3]]));
  const t33 = crc([ad[0]!, ad[1]!, ad[2]!, ad[3]!, ed[0]!, ed[1]!]);
  const t34 = crc([ed[2]!, ed[3]!, b[0], b[1], b[2], b[3]]);

  const t4 = processCrypto(prepareVariables4(sensorUid, t31, t32, t33, t34));
  return new Uint8Array([...b, ...wordsToBytes(t4)]);
}

/** `Libre2.LibreBLEResponse`. */
export interface LibreBleResponse {
  /** Sensor age in minutes. */
  readonly age: number;
  readonly trend: Measurement[];
  readonly history: Measurement[];
  readonly crcVerified: boolean;
}

const TREND_OFFSETS = [0, 2, 4, 6, 7, 12, 15] as const;

/**
 * `Libre2.parseBLEData(_:)` on a decrypted 44-byte packet. `now` replaces Swift's `Date()`.
 * Faithful quirk: every record `i` is time-stamped `now - i` minutes even though the trend
 * records are 0/2/4/6/7/12/15 minutes old (`idValue` carries the real minute counter).
 */
export function parseBleData(data: Bytes, now: number): LibreBleResponse {
  if (data.length < 44) throw new Libre2DecryptionError(`BLE payload too short (${data.length} bytes)`);
  const age = (data[41]! << 8) + data[40]!;
  const calculatedCrc = libreCrc16(data.subarray(0, data.length - 2), 0xffff);
  const enclosedCrc = (data[42]! << 8) | data[43]!;
  const delay = 2;
  const trend: Measurement[] = [];
  const history: Measurement[] = [];
  for (let i = 0; i < 10; i++) {
    const rawGlucose = readBits(data, i * 4, 0, 0xe);
    if (rawGlucose === 0) continue;
    const rawTemperature = readBits(data, i * 4, 0xe, 0xc) << 2;
    let rawTemperatureAdjustment = readBits(data, i * 4, 0x1a, 0x5) << 2;
    if (readBits(data, i * 4, 0x1f, 0x1) !== 0) rawTemperatureAdjustment = -rawTemperatureAdjustment;
    let idValue = age;
    if (i < 7) idValue -= TREND_OFFSETS[i]!;
    else idValue = Math.trunc((idValue - delay) / 15) * 15 - 15 * (i - 7);
    const m = createMeasurement({ date: now - 60_000 * i, rawGlucose, rawTemperature, rawTemperatureAdjustment, idValue });
    (i < 7 ? trend : history).push(m);
  }
  trend.sort((a, b) => a.idValue - b.idValue);
  history.sort((a, b) => a.idValue - b.idValue);
  return { age, trend, history, crcVerified: calculatedCrc === enclosedCrc };
}
