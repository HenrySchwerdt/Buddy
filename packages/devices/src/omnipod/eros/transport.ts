/**
 * TypeScript port of `Eros/ErosMessageTransport.swift` (OmnipodKit, MIT License, (c) LoopKit Authors /
 * Pete Schwamb): fragments a message into PDM/CON packets, runs the packet exchange with retries,
 * reassembles the (possibly multi-packet) response with ACKs and finally ACKs until the pod is quiet.
 *
 * Bytes in, bytes out: `sendMessage` takes the complete message (header + blocks + CRC16) and returns the
 * complete, CRC/address/sequence-checked response message. Block encoding/decoding is up to the caller.
 */
import { concatBytes, hex, silentLogger, systemClock, type Bytes, type Clock, type Logger } from '@buddy/core';
import { isRileyLinkError, type PacketRadio } from '../../rileylink';
import { PAIRING_ADDRESS } from './address';
import { ErosTransportError } from './errors';
import { inspectMessage } from './message-frame';
import { decodePacket, encodePacket, makePacket, PacketType, type Packet } from './packet';

export interface ErosTransportState {
  /** 5-bit radio packet counter. */
  readonly packetNumber: number;
  /** 4-bit message counter; the next message must use this as its sequence number. */
  readonly messageNumber: number;
}

export interface ErosTiming {
  readonly packetResponseTimeoutMs: number;
  readonly exchangeTimeoutMs: number;
  readonly preambleExtensionMs: number;
  readonly radioRetryCount: number;
  readonly conAckRepeatCount: number;
  readonly ackPreambleExtensionMs: number;
  readonly quietWindowMs: number;
}

export const DEFAULT_EROS_TIMING: ErosTiming = {
  packetResponseTimeoutMs: 333,
  exchangeTimeoutMs: 9000,
  preambleExtensionMs: 127,
  radioRetryCount: 9,
  conAckRepeatCount: 3,
  ackPreambleExtensionMs: 40,
  quietWindowMs: 300,
};

export interface MessageLogger {
  didSend(message: Bytes): void;
  didReceive(message: Bytes): void;
  didError(description: string): void;
}

export interface ErosMessageTransportOptions {
  readonly radio: PacketRadio;
  /** Pod address; `PAIRING_ADDRESS` (default) while assigning an address. */
  readonly address?: number;
  /** Address put in ACK bodies; during pairing this is the address being assigned. Defaults to `address`. */
  readonly ackAddress?: number;
  readonly state?: ErosTransportState;
  readonly clock?: Clock;
  readonly log?: Logger;
  readonly timing?: Partial<ErosTiming>;
  readonly messageLogger?: MessageLogger;
  readonly onStateChange?: (state: ErosTransportState) => void;
}

const seqOf = (message: Bytes) => (message[4]! >> 2) & 0b1111;

export class ErosMessageTransport {
  private _state: ErosTransportState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly radio: PacketRadio;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly timing: ErosTiming;
  readonly address: number;
  readonly ackAddress: number;

  constructor(private readonly o: ErosMessageTransportOptions) {
    this.radio = o.radio;
    this.address = (o.address ?? PAIRING_ADDRESS) >>> 0;
    this.ackAddress = (o.ackAddress ?? this.address) >>> 0;
    this._state = o.state ?? { packetNumber: 0, messageNumber: 0 };
    this.clock = o.clock ?? systemClock;
    this.log = o.log ?? silentLogger;
    this.timing = { ...DEFAULT_EROS_TIMING, ...o.timing };
  }

  get state(): ErosTransportState {
    return this._state;
  }
  get packetNumber(): number {
    return this._state.packetNumber;
  }
  get messageNumber(): number {
    return this._state.messageNumber;
  }

  private update(patch: Partial<ErosTransportState>): void {
    this._state = { ...this._state, ...patch };
    this.o.onStateChange?.(this._state);
  }
  private bumpPacket(n = 1): void {
    this.update({ packetNumber: (this._state.packetNumber + n) & 0b11111 });
  }
  private bumpMessage(n = 1): void {
    this.update({ messageNumber: (this._state.messageNumber + n) & 0b1111 });
  }

  private ackPacket(): Packet {
    const body = new Uint8Array(4);
    new DataView(body.buffer).setUint32(0, this.ackAddress);
    return makePacket(this.address, PacketType.ack, this.packetNumber, body);
  }

  /** Keeps ACKing the final packet until the pod stops talking for a quiet window. */
  private async ackUntilQuiet(): Promise<void> {
    const data = encodePacket(this.ackPacket());
    const quiet = this.timing.quietWindowMs;
    let lastHeard = this.clock.now();
    for (let i = 0; i < 100 && this.clock.now() - lastHeard < quiet; i++) {
      try {
        const rf = await this.radio.sendAndListen(data, {
          repeatCount: 1,
          timeoutMs: quiet,
          retryCount: 0,
          preambleExtensionMs: this.timing.ackPreambleExtensionMs,
        });
        if (decodePacket(rf.data).address === this.address) lastHeard = this.clock.now();
      } catch (e) {
        if (isRileyLinkError(e, 'responseTimeout')) break; // pod heard our ack
        if (isRileyLinkError(e, 'disconnected')) break;
      }
    }
    this.bumpPacket();
  }

  /**
   * Sends one packet and waits for the pod's reply packet (address, sequence number and CRC checked).
   * @throws ErosTransportError `noResponseRL`; RileyLinkError other than responseTimeout
   */
  private async exchangePackets(
    packet: Packet,
    o: { repeatCount?: number; preambleExtensionMs?: number } = {},
  ): Promise<Packet> {
    const data = encodePacket(packet);
    const start = this.clock.now();
    this.bumpPacket();
    while (this.clock.now() - start < this.timing.exchangeTimeoutMs) {
      try {
        const rf = await this.radio.sendAndListen(data, {
          repeatCount: o.repeatCount ?? 0,
          timeoutMs: this.timing.packetResponseTimeoutMs,
          retryCount: this.timing.radioRetryCount,
          preambleExtensionMs: o.preambleExtensionMs ?? this.timing.preambleExtensionMs,
        });
        let candidate: Packet;
        try {
          candidate = decodePacket(rf.data);
          this.log.info(`Eros recv (${rf.rssi} dBm): ${hex(rf.data)}`);
        } catch (e) {
          this.log.info(`Eros: dropped undecodable packet ${hex(rf.data)}: ${(e as Error).message}`);
          continue;
        }
        if (candidate.address !== packet.address && candidate.address !== PAIRING_ADDRESS) {
          this.log.info(`Eros: packet address ${candidate.address.toString(16)} != ${packet.address.toString(16)}`);
          continue;
        }
        if (candidate.sequenceNum !== ((packet.sequenceNum + 1) & 0b11111)) {
          this.log.info(`Eros: packet sequence ${candidate.sequenceNum} != ${(packet.sequenceNum + 1) & 0b11111}`);
          continue;
        }
        // The pod heard us: only now is it safe to advance the counter again.
        this.bumpPacket();
        return candidate;
      } catch (e) {
        if (isRileyLinkError(e, 'responseTimeout')) continue;
        throw e;
      }
    }
    throw new ErosTransportError('noResponseRL', 'No response from the pod via RileyLink');
  }

  /**
   * Sends a complete message and returns the pod's complete response message.
   * Calls are serialised. The caller builds the message with `sequenceNum = transport.messageNumber`.
   *
   * @throws ErosTransportError `invalidMessage` (nothing sent); otherwise, once the whole message was
   *   (partly) on the air, `unacknowledgedMessage` (delivery unknown; see `cause`/`rootKind`), or before
   *   that `noResponseRL`/`commsError`.
   */
  sendMessage(message: Bytes): Promise<Bytes> {
    const run = () => this.sendMessageNow(message);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async sendMessageNow(message: Bytes): Promise<Bytes> {
    const frame = inspectMessage(message);
    if (frame.status !== 'ok' || frame.bodyLength + 8 !== message.length) {
      throw new ErosTransportError('invalidMessage', `Malformed message (${frame.status}): ${hex(message)}`);
    }
    const sequenceNum = seqOf(message);
    this.update({ messageNumber: sequenceNum });
    this.bumpMessage();
    let sentFullMessage = false;
    try {
      let remaining = message;
      this.log.info(`Eros send: ${hex(message)}`);
      this.o.messageLogger?.didSend(message);
      let responsePacket: Packet;
      for (let first = true; ; first = false) {
        const sendPacket = makePacket(this.address, first ? PacketType.pdm : PacketType.con, this.packetNumber, remaining);
        remaining = remaining.slice(sendPacket.data.length);
        if (remaining.length === 0) sentFullMessage = true;
        const response = await this.exchangePackets(sendPacket);
        if (remaining.length === 0) {
          responsePacket = response;
          break;
        }
      }
      if (responsePacket.packetType === PacketType.ack) {
        this.o.messageLogger?.didReceive(encodePacket(responsePacket));
        throw new ErosTransportError('podAckedInsteadOfReturningResponse', 'Pod acked instead of returning a response');
      }
      const response = await this.assemble(responsePacket);
      await this.ackUntilQuiet();
      const done = inspectMessage(response);
      if (done.status === 'ok' && done.bodyLength === 0) {
        throw new ErosTransportError('emptyResponse', 'Empty response');
      }
      this.bumpMessage();
      return response;
    } catch (e) {
      if (sentFullMessage) {
        this.o.messageLogger?.didError(`Unacknowledged message. seq:${sequenceNum}, error = ${(e as Error).message}`);
        throw new ErosTransportError('unacknowledgedMessage', `Message ${sequenceNum} was sent but not acknowledged: ${(e as Error).message}`, e, sequenceNum);
      }
      if (e instanceof ErosTransportError) throw e;
      throw new ErosTransportError('commsError', (e as Error).message, e);
    }
  }

  /** Collects CON packets (ACKing each) until the response message is complete, then validates it. */
  private async assemble(first: Packet): Promise<Bytes> {
    let data = first.data;
    for (;;) {
      const frame = inspectMessage(data);
      switch (frame.status) {
        case 'notEnoughData': {
          this.log.info('Eros: sending ACK for CON');
          const con = await this.exchangePackets(this.ackPacket(), {
            repeatCount: this.timing.conAckRepeatCount,
            preambleExtensionMs: this.timing.ackPreambleExtensionMs,
          });
          if (con.packetType !== PacketType.con) {
            throw new ErosTransportError('unexpectedPacketType', `Expected CON packet, received type ${con.packetType}`);
          }
          data = concatBytes(data, con.data);
          break;
        }
        case 'invalidCrc':
          throw new ErosTransportError('invalidCrc', 'Invalid message CRC');
        case 'ok':
          if (frame.address !== this.address) {
            this.o.messageLogger?.didReceive(data);
            throw new ErosTransportError('invalidAddress', `Invalid address ${frame.address.toString(16)}`);
          }
          if (frame.sequenceNum !== this.messageNumber) {
            this.o.messageLogger?.didReceive(data);
            throw new ErosTransportError('invalidSequence', `Unexpected message sequence ${frame.sequenceNum}`);
          }
          this.log.info(`Eros recv message: ${hex(data)}`);
          this.o.messageLogger?.didReceive(data);
          return data;
      }
    }
  }
}
