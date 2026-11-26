/**
 * TypeScript port of `Radio/FourByteSixByteEncoding.swift` from MinimedKit (migrated from
 * ps2/rileylink_ios, MIT License, (c) LoopKit Authors): the 4b/6b line code of Medtronic RF
 * packets (every nibble becomes a 6 bit symbol, the stream is packed MSB first).
 */
import type { Bytes } from '@buddy/core';

const CODES: readonly number[] = [21, 49, 50, 35, 52, 37, 38, 22, 26, 25, 42, 11, 44, 13, 14, 28];
const CODES_REV: ReadonlyMap<number, number> = new Map(CODES.map((code, nibble) => [code, nibble]));

/** Null when a 6 bit symbol is not part of the code (corrupted packet). Decoding stops at the first 0 byte. */
export function decode4b6b(input: Bytes): Bytes | null {
  const out: number[] = [];
  let availBits = 0;
  let acc = 0;
  for (const byte of input) {
    if (byte === 0) break;
    acc = (acc << 8) + byte;
    availBits += 8;
    if (availBits >= 12) {
      const hi = CODES_REV.get(acc >> (availBits - 6));
      const lo = CODES_REV.get((acc >> (availBits - 12)) & 0b111111);
      if (hi === undefined || lo === undefined) return null;
      out.push((hi << 4) + lo);
      availBits -= 12;
      acc &= 0xffff >> (16 - availBits);
    }
  }
  return Uint8Array.from(out);
}

export function encode4b6b(input: Bytes): Bytes {
  const out: number[] = [];
  let acc = 0;
  let bitCount = 0;
  for (const byte of input) {
    acc = (acc << 6) | CODES[byte >> 4]!;
    bitCount += 6;
    acc = (acc << 6) | CODES[byte & 0x0f]!;
    bitCount += 6;
    while (bitCount >= 8) {
      out.push((acc >> (bitCount - 8)) & 0xff);
      bitCount -= 8;
      acc &= 0xffff >> (16 - bitCount);
    }
  }
  if (bitCount > 0) {
    acc <<= 8 - bitCount;
    out.push(acc & 0xff);
  }
  return Uint8Array.from(out);
}
