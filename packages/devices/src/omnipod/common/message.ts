/**
 * Omnipod message framing. Port of `OmnipodCommon/Message.swift` from OmnipodKit
 * (MIT License, (c) LoopKit Authors): address, 4-bit sequence number, blocks, CRC16.
 * Transport independent: DASH wraps this in an encrypted BLE packet, Eros in RF packets.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { be16, be32, u16be, u32be } from './bytes';
import { crc16 } from './crc16';
import { decodeBlock, isFaulted, MessageError } from './blocks/decode';
import { encodeBlock } from './blocks/encode';
import type { DetailedStatus, MessageBlock } from './blocks/types';

export interface Message {
  readonly address: number;
  readonly blocks: readonly MessageBlock[];
  /** 4-bit message number (0..15) */
  readonly sequenceNum: number;
  readonly expectFollowOnMessage: boolean;
}

export const makeMessage = (address: number, blocks: readonly MessageBlock[], sequenceNum: number, expectFollowOnMessage = false): Message => ({
  address,
  blocks,
  sequenceNum,
  expectFollowOnMessage,
});

export function encodeMessage(m: Message): Bytes {
  const body = concatBytes(...m.blocks.map(encodeBlock));
  const b9 = ((m.expectFollowOnMessage ? 1 : 0) << 7) + ((m.sequenceNum & 0b1111) << 2) + ((body.length >> 8) & 0b11);
  const head = concatBytes(be32(m.address), new Uint8Array([b9, body.length & 0xff]), body);
  return concatBytes(head, be16(crc16(head)));
}

export function decodeMessage(data: Bytes, checkCrc = true): Message {
  if (data.length < 10) throw new MessageError('Not enough data', 'notEnoughData');
  const bodyLen = data[5]!;
  if (bodyLen > data.length - 8) throw new MessageError('Not enough data', 'notEnoughData');
  if (checkCrc && crc16(data.subarray(0, data.length - 2)) !== u16be(data, data.length - 2)) throw new MessageError('Invalid CRC', 'invalidCrc');
  const b9 = data[4]!;
  const blocksData = data.subarray(6, data.length - 2);
  const blocks: MessageBlock[] = [];
  let idx = 0;
  do {
    let decoded;
    try {
      decoded = decodeBlock(blocksData.subarray(idx));
    } catch (e) {
      if (e instanceof MessageError) throw new MessageError(`Parsing error at offset ${idx}: ${e.message}`, 'parsingError');
      throw e;
    }
    if (decoded.length <= 0) throw new MessageError('Zero length block', 'parsingError');
    blocks.push(decoded.block);
    idx += decoded.length;
  } while (idx < blocksData.length);
  return {
    address: u32be(data, 0),
    blocks,
    sequenceNum: (b9 >> 2) & 0b1111,
    expectFollowOnMessage: (b9 & 0x80) !== 0,
  };
}

/** The detailed status if the pod answered with a faulted one (what OmnipodKit calls `Message.fault`). */
export function messageFault(m: Message): DetailedStatus | null {
  const first = m.blocks[0];
  if (first?.type === 'podInfoResponse' && first.info.podInfoType === 2) {
    const info = first.info as DetailedStatus;
    return isFaulted(info) ? info : null;
  }
  return null;
}
