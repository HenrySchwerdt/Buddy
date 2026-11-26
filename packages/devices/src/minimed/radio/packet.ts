/**
 * TypeScript port of `Radio/MinimedPacket.swift` from MinimedKit (migrated from
 * ps2/rileylink_ios, MIT License, (c) LoopKit Authors): a Medtronic RF packet is the message,
 * its CRC-8, 4b/6b encoded and closed by a 0 byte. The RileyLink radio does no encoding for
 * these pumps, so the host does it.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { crc8 } from './crc8';
import { decode4b6b, encode4b6b } from './four-b-six-b';

/** The bytes to put on the air for `message`. */
export function encodeMinimedPacket(message: Bytes): Bytes {
  const withCrc = concatBytes(message, Uint8Array.of(crc8(message)));
  return concatBytes(encode4b6b(withCrc), Uint8Array.of(0));
}

/** The message inside a received packet; null when the 4b/6b code or the CRC is wrong. */
export function decodeMinimedPacket(encoded: Bytes): Bytes | null {
  const decoded = decode4b6b(encoded);
  if (!decoded || decoded.length === 0) return null;
  const message = decoded.subarray(0, decoded.length - 1);
  return decoded[decoded.length - 1] === crc8(message) ? message.slice() : null;
}
