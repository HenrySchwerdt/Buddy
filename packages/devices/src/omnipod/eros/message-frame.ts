/**
 * Frame-level view of an Omnipod message, ported from the header/CRC handling in
 * `OmnipodCommon/Message.swift` (OmnipodKit, MIT License, (c) LoopKit Authors / Pete Schwamb).
 * Layout: `[address(4) | b9 | len | blocks... | crc16(2)]`, b9 = followOn<<7 | seq<<2 | len>>8.
 * Only what the radio transport needs: completeness, CRC, address and sequence. Block parsing belongs
 * to the common message layer.
 */
import { u16be, u32be, type Bytes } from '@buddy/core';
import { crc16 } from './crc16';

export const MESSAGE_OVERHEAD = 8; // 6 header + 2 crc
export const MIN_MESSAGE_LENGTH = 10;

export type MessageFrame =
  | { readonly status: 'notEnoughData' }
  | { readonly status: 'invalidCrc' }
  | { readonly status: 'ok'; readonly address: number; readonly sequenceNum: number; readonly expectFollowOn: boolean; readonly bodyLength: number };

export function inspectMessage(data: Bytes): MessageFrame {
  if (data.length < MIN_MESSAGE_LENGTH) return { status: 'notEnoughData' };
  const bodyLength = ((data[4]! & 0b11) << 8) | data[5]!;
  if (bodyLength > data.length - MESSAGE_OVERHEAD) return { status: 'notEnoughData' };
  if (crc16(data.subarray(0, data.length - 2)) !== u16be(data, data.length - 2)) return { status: 'invalidCrc' };
  return {
    status: 'ok',
    address: u32be(data, 0),
    sequenceNum: (data[4]! >> 2) & 0b1111,
    expectFollowOn: (data[4]! & 0x80) !== 0,
    bodyLength,
  };
}

/** Builds a complete message frame around already-encoded message blocks. */
export function encodeMessageFrame(o: { address: number; sequenceNum: number; body: Bytes; expectFollowOn?: boolean }): Bytes {
  const out = new Uint8Array(o.body.length + MESSAGE_OVERHEAD);
  new DataView(out.buffer).setUint32(0, o.address >>> 0);
  out[4] = ((o.expectFollowOn ? 0x80 : 0) | ((o.sequenceNum & 0b1111) << 2) | ((o.body.length >> 8) & 0b11)) & 0xff;
  out[5] = o.body.length & 0xff;
  out.set(o.body, 6);
  new DataView(out.buffer).setUint16(out.length - 2, crc16(out.subarray(0, out.length - 2)));
  return out;
}
