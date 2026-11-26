/**
 * BLE fragmentation of DASH messages. Port of `Bluetooth/Packet/BLEPacket.swift`,
 * `PayloadSplitter.swift` and `PayloadJoiner.swift` from OmnipodKit (MIT License,
 * (c) LoopKit Authors). Packet 0 = first, 1..n-1 = middle, then last and optionally one more.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { be32, bytesEqual } from '../common/bytes';
import { DASH_PACKET_LAYOUT as L } from './constants';
import { crc32 } from './crc32';
import { OmnipodError } from './errors';

const FIRST_CAPACITY_WITH_MIDDLE = L.maxPayloadSize - L.firstPacketHeaderSizeWithMiddlePackets;
const FIRST_CAPACITY_WITHOUT_MIDDLE = L.maxPayloadSize - L.firstPacketHeaderSizeWithoutMiddlePackets;
const MIDDLE_CAPACITY = L.maxPayloadSize - 1;
const LAST_CAPACITY = L.maxPayloadSize - L.lastPacketHeaderSize;
const PLUS_ONE_HEADER = 2;

const protocolError = (m: string): OmnipodError => new OmnipodError('protocol', m);
const pad = (b: Bytes, to: number): Bytes => (b.length >= to ? b : concatBytes(b, new Uint8Array(to - b.length)));
const u8 = (...v: number[]): Bytes => new Uint8Array(v);

/** Splits one message payload into the packets to write to the data characteristic. */
export function splitPayload(payload: Bytes): Bytes[] {
  const crc = be32(crc32(payload));
  if (payload.length <= FIRST_CAPACITY_WITH_MIDDLE) {
    const end = Math.min(FIRST_CAPACITY_WITHOUT_MIDDLE, payload.length);
    const packets = [concatBytes(u8(0, 0), crc, u8(payload.length), payload.subarray(0, end))];
    if (payload.length > FIRST_CAPACITY_WITHOUT_MIDDLE) {
      packets.push(pad(concatBytes(u8(1, payload.length - end), payload.subarray(end)), L.maxPayloadSize));
    }
    return packets;
  }
  const middleFragments = Math.trunc((payload.length - FIRST_CAPACITY_WITH_MIDDLE) / MIDDLE_CAPACITY);
  const rest = payload.length - middleFragments * MIDDLE_CAPACITY - FIRST_CAPACITY_WITH_MIDDLE;
  if (middleFragments + 1 > L.maxFragments) throw protocolError('Message too long for the DASH link');
  const packets: Bytes[] = [concatBytes(u8(0, middleFragments + 1), payload.subarray(0, FIRST_CAPACITY_WITH_MIDDLE))];
  for (let i = 1; i <= middleFragments; i++) {
    const from = FIRST_CAPACITY_WITH_MIDDLE + (i - 1) * MIDDLE_CAPACITY;
    packets.push(concatBytes(u8(i), payload.subarray(from, from + MIDDLE_CAPACITY)));
  }
  const lastFrom = middleFragments * MIDDLE_CAPACITY + FIRST_CAPACITY_WITH_MIDDLE;
  const lastEnd = Math.min(LAST_CAPACITY, rest);
  packets.push(pad(concatBytes(u8(middleFragments + 1, rest), crc, payload.subarray(lastFrom, lastFrom + lastEnd)), L.maxPayloadSize));
  if (rest > LAST_CAPACITY) {
    packets.push(pad(concatBytes(u8(middleFragments + 2, rest - LAST_CAPACITY), payload.subarray(lastFrom + LAST_CAPACITY)), L.maxPayloadSize));
  }
  return packets;
}

/** Reassembles a message from the packets the pod notified on the data characteristic. */
export class PayloadJoiner {
  readonly fullFragments: number;
  oneExtraPacket: boolean;
  private crc: Bytes | null;
  private expectedIndex = 0;
  private readonly fragments: Bytes[] = [];

  constructor(first: Bytes) {
    if (first.length < L.firstPacketHeaderSizeWithMiddlePackets) throw protocolError('Wrong packet size');
    if (first[0] !== 0) throw protocolError(`Incorrect packet: expected index 0, got ${first[0]}`);
    this.fullFragments = first[1]!;
    if (this.fullFragments > L.maxFragments) throw protocolError(`Received more than ${L.maxFragments} fragments`);
    if (first.length < L.firstPacketHeaderSizeWithoutMiddlePackets) throw protocolError('Wrong packet size');
    if (this.fullFragments === 0) {
      const rest = first[6]!;
      const end = Math.min(rest + L.firstPacketHeaderSizeWithoutMiddlePackets, first.length);
      this.fragments.push(first.slice(L.firstPacketHeaderSizeWithoutMiddlePackets, end));
      this.crc = first.slice(2, 6);
      this.oneExtraPacket = rest + L.firstPacketHeaderSizeWithoutMiddlePackets > end;
    } else {
      if (first.length < L.maxPayloadSize) throw protocolError('Incorrect packet: first packet too short');
      this.fragments.push(first.slice(L.firstPacketHeaderSizeWithMiddlePackets, L.maxPayloadSize));
      this.crc = null;
      this.oneExtraPacket = false;
    }
  }

  accumulate(packet: Bytes): void {
    if (packet.length < 3) throw protocolError(`Incorrect packet at ${this.expectedIndex + 1}`);
    const idx = packet[0]!;
    if (idx !== this.expectedIndex + 1) throw protocolError(`Incorrect packet: expected index ${this.expectedIndex + 1}, got ${idx}`);
    this.expectedIndex += 1;
    if (idx < this.fullFragments) {
      if (packet.length < L.maxPayloadSize) throw protocolError('Wrong packet size');
      this.fragments.push(packet.slice(1, L.maxPayloadSize));
    } else if (idx === this.fullFragments) {
      if (packet.length < L.lastPacketHeaderSize) throw protocolError('Wrong packet size');
      const rest = packet[1]!;
      const end = Math.min(rest + L.lastPacketHeaderSize, packet.length);
      this.fragments.push(packet.slice(L.lastPacketHeaderSize, end));
      this.crc = packet.slice(2, 6);
      this.oneExtraPacket = rest + L.lastPacketHeaderSize > end;
    } else if (idx === this.fullFragments + 1 && this.oneExtraPacket) {
      const size = packet[1]!;
      if (packet.length < PLUS_ONE_HEADER + size) throw protocolError('Wrong packet size');
      this.fragments.push(packet.slice(PLUS_ONE_HEADER, PLUS_ONE_HEADER + size));
    } else {
      throw protocolError(`Incorrect packet at index ${idx}`);
    }
  }

  finalize(): Bytes {
    const payload = concatBytes(...this.fragments);
    const computed = be32(crc32(payload));
    if (this.crc === null || !bytesEqual(this.crc, computed)) throw protocolError('Payload CRC32 mismatch');
    return payload;
  }
}
