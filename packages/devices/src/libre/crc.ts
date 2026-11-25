/**
 * TypeScript port of `LibreSensor/SensorContents/CRC.swift` from loopandlearn/LibreTransmitter
 * (MIT, (c) Uwe Petersen, Marcin Krzyzanowski and the LibreTransmitter authors).
 *
 * Freestyle Libre CRC: a reflected CRC-16 (CCITT polynomial, table from CryptoSwift) whose
 * result is bit-reversed and byte-swapped (modification by Uwe Petersen, 2016).
 */
import type { Bytes } from '@buddy/core';

/** The Swift file hard-codes this 256-entry table; it is the reflected 0x1021 (0x8408) table. */
export const CRC16_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  return c;
});

const reverse16 = (value: number): number => {
  let crc = value;
  let reversed = 0;
  for (let i = 0; i < 16; i++) {
    reversed = ((reversed << 1) | (crc & 1)) & 0xffff;
    crc >>>= 1;
  }
  return reversed;
};

export const byteSwap16 = (v: number): number => ((v & 0xff) << 8) | ((v >>> 8) & 0xff);

/** `Crc.crc16(_:seed:)`. */
export function libreCrc16(message: ArrayLike<number>, seed = 0x0000): number {
  let crc = seed & 0xffff;
  for (let i = 0; i < message.length; i++) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ message[i]!) & 0xff]!;
  }
  return byteSwap16(reverse16(crc));
}

/** `Crc.hasValidCrc16InFirstTwoBytes`: big-endian CRC in bytes 0..1 over the rest. */
export function hasValidCrc16InFirstTwoBytes(bytes: Bytes): boolean {
  if (bytes.length < 2) return false;
  const calculated = libreCrc16(bytes.subarray(2), 0xffff);
  const enclosed = (bytes[0]! << 8) | bytes[1]!;
  return calculated === enclosed;
}

/** `Crc.hasValidCrc16InLastTwoBytes`: big-endian CRC in the last two bytes over the rest. */
export function hasValidCrc16InLastTwoBytes(bytes: Bytes): boolean {
  if (bytes.length < 2) return false;
  const calculated = libreCrc16(bytes.subarray(0, bytes.length - 2), 0xffff);
  const enclosed = (bytes[bytes.length - 2]! << 8) | bytes[bytes.length - 1]!;
  return calculated === enclosed;
}

/** `Crc.bytesWithCorrectCRC`: returns a copy with a fresh CRC in the first two bytes. */
export function bytesWithCorrectCrc(bytes: Bytes): Bytes {
  const crc = libreCrc16(bytes.subarray(2), 0xffff);
  const out = bytes.slice();
  out[0] = crc >>> 8;
  out[1] = crc & 0xff;
  return out;
}
