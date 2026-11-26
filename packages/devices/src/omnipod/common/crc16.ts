/**
 * Port of `OmnipodCommon/CRC16.swift` from OmnipodKit (MIT License, (c) LoopKit Authors).
 *
 * Omnipod messages use a table taken from CRC-16/BUYPASS (poly 0x8005) but fold bytes with a
 * right-shifting accumulator, so the usual CRC catalogue algorithms do not match. The table is
 * derived from the polynomial; the test suite pins the result against OmnipodKit's vectors.
 */
import type { Bytes } from '@buddy/core';

export const CRC16_TABLE: readonly number[] = Array.from({ length: 256 }, (_, i) => {
  let crc = i << 8;
  for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  return crc;
});

export function crc16(data: Bytes): number {
  let acc = 0;
  for (const byte of data) acc = (acc >>> 8) ^ CRC16_TABLE[(acc ^ byte) & 0xff]!;
  return acc & 0xffff;
}
