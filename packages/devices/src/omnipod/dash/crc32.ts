/**
 * CRC-32 (IEEE 802.3, reflected, init/xorout 0xFFFFFFFF) as CryptoSwift's `Data.crc32()` computes it
 * for the BLE payloads of OmnipodKit (MIT License, (c) LoopKit Authors).
 */
import type { Bytes } from '@buddy/core';

const TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Bytes): number {
  let crc = 0xffffffff;
  for (const b of data) crc = TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
