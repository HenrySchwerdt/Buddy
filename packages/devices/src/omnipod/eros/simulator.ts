/**
 * Radio-level simulator of an Eros pod for tests (original work; behaviour follows the packet flow of
 * `ErosMessageTransport.swift`, OmnipodKit, MIT License, (c) LoopKit Authors). Plug `respond` into
 * `RileyLinkSimulator` (`onRadio`) or wrap it as a `PacketRadio`.
 *
 * The pod reassembles PDM/CON packets into a message, hands it to `onMessage`, and answers with either
 * an ACK (when `onMessage` returns null, or while the message is incomplete) or the response message
 * fragmented into POD/CON packets, the next fragment being released by each PDM ACK. A repeated packet
 * (same sequence number, e.g. a radio retry) gets the previous answer again.
 */
import type { Bytes } from '@buddy/core';
import { PAIRING_ADDRESS } from './address';
import { inspectMessage } from './message-frame';
import { decodePacket, encodePacket, fragmentMessage, makePacket, PacketType } from './packet';

export interface ErosPodSimulatorOptions {
  /** Address the pod listens on (PAIRING_ADDRESS accepts everything and answers with that address). */
  readonly address: number;
  /** Address used in the pod's own packet headers (defaults to `address`). */
  readonly replyAddress?: number;
  readonly onMessage: (message: Bytes) => Bytes | null;
}

export class ErosPodSimulator {
  private incoming: Bytes = new Uint8Array(0);
  private outgoing: Bytes[] = [];
  private lastRx: { seq: number; reply: Bytes | null } | null = null;
  /** Complete messages the pod received. */
  readonly received: Bytes[] = [];
  /** Number of radio packets the pod heard, including retries. */
  heard = 0;
  /** Drop the next `n` packets as if they were lost before reaching the pod. */
  dropNext = 0;
  /** Drop the next `n` replies as if they were lost on the way back. */
  dropNextReplies = 0;
  /** Flip a bit in the next reply (CRC failure at the PDM). */
  corruptNextReply = false;

  constructor(private readonly o: ErosPodSimulatorOptions) {}

  /** Handles one over-the-air packet; returns the reply packet bytes or null for silence. */
  respond = (tx: Bytes | null): Bytes | null => {
    if (!tx) return null;
    if (this.dropNext > 0) {
      this.dropNext--;
      return null;
    }
    let packet;
    try {
      packet = decodePacket(tx);
    } catch {
      return null;
    }
    if (this.o.address !== PAIRING_ADDRESS && packet.address !== this.o.address) return null;
    this.heard++;
    const replyAddress = this.o.replyAddress ?? this.o.address;
    const replySeq = (packet.sequenceNum + 1) & 0b11111;

    let reply: Bytes | null;
    if (this.lastRx && this.lastRx.seq === packet.sequenceNum) {
      reply = this.lastRx.reply; // retry of a packet we already processed
    } else {
      reply = this.process(packet.packetType, packet.data, replyAddress, replySeq);
      this.lastRx = { seq: packet.sequenceNum, reply };
    }
    if (reply && this.dropNextReplies > 0) {
      this.dropNextReplies--;
      return null;
    }
    if (reply && this.corruptNextReply) {
      this.corruptNextReply = false;
      const bad = reply.slice();
      bad[bad.length - 2] = bad[bad.length - 2]! ^ 0x01;
      return bad;
    }
    return reply;
  };

  private process(type: number, data: Bytes, address: number, seq: number): Bytes | null {
    if (type === PacketType.ack) {
      const next = this.outgoing.shift();
      return next ? encodePacket(makePacket(address, PacketType.con, seq, next)) : null;
    }
    if (type === PacketType.pdm) this.incoming = data.slice();
    else if (type === PacketType.con) this.incoming = Uint8Array.from([...this.incoming, ...data]);
    else return null;

    if (inspectMessage(this.incoming).status === 'notEnoughData') return this.ack(address, seq);
    const message = this.incoming;
    this.incoming = new Uint8Array(0);
    this.received.push(message);
    const response = this.o.onMessage(message);
    if (!response) return this.ack(address, seq);
    const [first, ...rest] = fragmentMessage(response);
    this.outgoing = rest;
    return encodePacket(makePacket(address, PacketType.pod, seq, first!));
  }

  private ack(address: number, seq: number): Bytes {
    const body = new Uint8Array(4);
    new DataView(body.buffer).setUint32(0, address);
    return encodePacket(makePacket(address, PacketType.ack, seq, body));
  }
}
