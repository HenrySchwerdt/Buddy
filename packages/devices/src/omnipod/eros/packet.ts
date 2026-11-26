/**
 * TypeScript port of `Eros/Packet.swift` from OmnipodKit (MIT License, (c) LoopKit Authors /
 * Pete Schwamb): the Eros radio packet `[address(4) | type<<5 | seq | body | crc8]`.
 */
import { u32be, type Bytes } from '@buddy/core';
import { crc8 } from './crc8';

export const PacketType = { pod: 0b111, pdm: 0b101, con: 0b100, ack: 0b010 } as const;
export type PacketTypeValue = (typeof PacketType)[keyof typeof PacketType];
const TYPES: ReadonlySet<number> = new Set(Object.values(PacketType));

export const MAX_MESSAGE_FRAGMENT = 31;
export const maxBodyLen = (t: PacketTypeValue): number => (t === PacketType.ack ? 4 : MAX_MESSAGE_FRAGMENT);

export type PacketErrorKind = 'insufficientData' | 'crcMismatch' | 'unknownPacketType';
export class PacketError extends Error {
  constructor(readonly kind: PacketErrorKind, message: string) {
    super(message);
    this.name = 'PacketError';
  }
}

export interface Packet {
  readonly address: number;
  readonly packetType: PacketTypeValue;
  /** 5-bit packet sequence number. */
  readonly sequenceNum: number;
  readonly data: Bytes;
}

/** Builds a packet; a body longer than the type's maximum is truncated (the caller sends the rest later). */
export function makePacket(address: number, packetType: PacketTypeValue, sequenceNum: number, data: Bytes = new Uint8Array(0)): Packet {
  return { address: address >>> 0, packetType, sequenceNum, data: data.slice(0, maxBodyLen(packetType)) };
}

export function encodePacket(p: Packet): Bytes {
  const out = new Uint8Array(p.data.length + 6);
  new DataView(out.buffer).setUint32(0, p.address >>> 0);
  out[4] = ((p.packetType << 5) | (p.sequenceNum & 0b11111)) & 0xff;
  out.set(p.data, 5);
  out[out.length - 1] = crc8(out.subarray(0, out.length - 1));
  return out;
}

/** @throws PacketError */
export function decodePacket(encoded: Bytes): Packet {
  if (encoded.length < 7) throw new PacketError('insufficientData', 'Not enough data for a packet');
  const type = encoded[4]! >> 5;
  if (!TYPES.has(type)) throw new PacketError('unknownPacketType', `Unknown packet type ${type}`);
  const len = encoded.length;
  if (crc8(encoded.subarray(0, len - 1)) !== encoded[len - 1]) throw new PacketError('crcMismatch', 'Packet CRC mismatch');
  return {
    address: u32be(encoded, 0),
    packetType: type as PacketTypeValue,
    sequenceNum: encoded[4]! & 0b11111,
    data: encoded.slice(5, len - 1),
  };
}

/** Splits a message into the bodies of one PDM packet followed by CON packets (31 bytes each). */
export function fragmentMessage(message: Bytes): Bytes[] {
  const out: Bytes[] = [];
  for (let o = 0; o < message.length; o += MAX_MESSAGE_FRAGMENT) out.push(message.slice(o, o + MAX_MESSAGE_FRAGMENT));
  return out;
}
