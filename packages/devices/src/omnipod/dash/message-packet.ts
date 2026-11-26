/**
 * Port of `Bluetooth/MessagePacket.swift` and `Bluetooth/Id.swift` from OmnipodKit (MIT License,
 * (c) LoopKit Authors): the 16 byte "TW" header around pairing, session and encrypted payloads.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { be32, u32be } from '../common/bytes';
import { OmnipodError } from './errors';

export const MessageType = { CLEAR: 0, ENCRYPTED: 1, SESSION_ESTABLISHMENT: 2, PAIRING: 3, ENCRYPTED_SIGNED: 4 } as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

const HEADER_SIZE = 16;
const TAG_SIZE = 8;

export interface MessagePacket {
  readonly type: MessageType;
  readonly source: number;
  readonly destination: number;
  readonly payload: Bytes;
  readonly sequenceNumber: number;
  readonly ack: boolean;
  readonly ackNumber: number;
  readonly eqos: number;
  readonly priority: boolean;
  readonly lastMessage: boolean;
  readonly gateway: boolean;
  readonly sas: boolean;
  readonly tfs: boolean;
  readonly version: number;
}

export function makePacket(p: Pick<MessagePacket, 'type' | 'source' | 'destination' | 'payload' | 'sequenceNumber'> & Partial<MessagePacket>): MessagePacket {
  return { ack: false, ackNumber: 0, eqos: 0, priority: false, lastMessage: false, gateway: false, sas: true, tfs: false, version: 0, ...p };
}

const hasTag = (t: MessageType): boolean => t === MessageType.ENCRYPTED || t === MessageType.ENCRYPTED_SIGNED;

export function parseMessagePacket(data: Bytes): MessagePacket {
  if (data.length < HEADER_SIZE) throw new OmnipodError('protocol', 'Incorrect header size');
  if (data[0] !== 0x54 || data[1] !== 0x57) throw new OmnipodError('protocol', 'Magic pattern mismatch');
  const f1 = data[2]!;
  const f2 = data[3]!;
  const version = (f1 >> 5) & 0b111;
  if (version !== 0) throw new OmnipodError('protocol', 'Wrong version');
  const typeValue = f2 & 0xf;
  const type = (typeValue <= 4 ? typeValue : MessageType.CLEAR) as MessageType;
  const size = (data[6]! << 3) | (data[7]! >> 5);
  if (data.length < size + HEADER_SIZE) throw new OmnipodError('protocol', 'Wrong payload size');
  const payloadEnd = HEADER_SIZE + size + (hasTag(type) ? TAG_SIZE : 0);
  if (data.length < payloadEnd) throw new OmnipodError('protocol', 'Missing authentication tag');
  return {
    type,
    source: u32be(data, 8),
    destination: u32be(data, 12),
    payload: data.slice(HEADER_SIZE, payloadEnd),
    sequenceNumber: data[4]!,
    ack: (f2 & 0x80) !== 0,
    ackNumber: data[5]!,
    eqos: f1 & 0b111,
    priority: (f2 & 0x40) !== 0,
    lastMessage: (f2 & 0x20) !== 0,
    gateway: (f2 & 0x10) !== 0,
    sas: (f1 & 0x10) !== 0,
    tfs: (f1 & 0x08) !== 0,
    version,
  };
}

/** `forEncryption`: the payload is plain text (no tag), so the size field is its full length. */
export function encodeMessagePacket(m: MessagePacket, forEncryption = false): Bytes {
  const size = m.payload.length - (hasTag(m.type) && !forEncryption ? TAG_SIZE : 0);
  const f1 = ((m.version & 0b111) << 5) | (m.sas ? 0x10 : 0) | (m.tfs ? 0x08 : 0) | (m.eqos & 0b111);
  const f2 = (m.ack ? 0x80 : 0) | (m.priority ? 0x40 : 0) | (m.lastMessage ? 0x20 : 0) | (m.gateway ? 0x10 : 0) | (m.type & 0xf);
  const head = new Uint8Array([0x54, 0x57, f1, f2, m.sequenceNumber & 0xff, m.ackNumber & 0xff, (size >> 3) & 0xff, (size << 5) & 0xff]);
  return concatBytes(head, be32(m.source), be32(m.destination), m.payload);
}

/** The 16 header bytes used as AAD for the encryption. */
export const packetHeader = (m: MessagePacket, forEncryption: boolean): Bytes => encodeMessagePacket(m, forEncryption).subarray(0, HEADER_SIZE);
