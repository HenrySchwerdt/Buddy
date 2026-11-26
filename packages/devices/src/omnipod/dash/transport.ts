/**
 * Encrypted message transport of a DASH session. Port of `Bluetooth/BleMessageTransport.swift`
 * (`BlePodMessageTransport`, DASH path only) from OmnipodKit (MIT License, (c) LoopKit Authors):
 * wraps an Omnipod {@link Message} in an AES-CCM encrypted message packet, sends it, reads and
 * acknowledges the pod's answer.
 *
 * Failures are reported as {@link OmnipodError}: `unsent` = the pod certainly did not get the
 * command, `unacknowledged` = it may have (the driver then resolves it with a status request).
 */
import { fromHex, type Bytes } from '@buddy/core';
import { decodeMessage, encodeMessage, MessageError, type Message } from '../common';
import { COMMAND_PREFIX, COMMAND_SUFFIX, RESPONSE_PREFIX } from './constants';
import { makeEnDecrypt, type EnDecrypt } from './endecrypt';
import { errorMessage, OmnipodError } from './errors';
import type { PodLink } from './link';
import { makePacket, MessageType } from './message-packet';
import { formatKeys, parseKeys } from './string-prefix';

/** Persisted transport counters (hex strings for the keys). Treat the key fields as secrets. */
export interface TransportState {
  readonly ck: string | null;
  readonly noncePrefix: string | null;
  /** EAP-AKA sequence number of the session establishments */
  readonly eapSeq: number;
  /** 8-bit message packet sequence number */
  readonly msgSeq: number;
  readonly nonceSeq: number;
  /** 4-bit Omnipod message number of the next command */
  readonly messageNumber: number;
}

export const initialTransportState = (): TransportState => ({ ck: null, noncePrefix: null, eapSeq: 1, msgSeq: 0, nonceSeq: 0, messageNumber: 0 });

export class PodMessageTransport {
  private current: TransportState;
  private readonly crypt: EnDecrypt | null;

  constructor(
    private readonly link: PodLink,
    private readonly myId: number,
    private readonly podId: number,
    state: TransportState,
    private readonly onState: (s: TransportState) => void = () => {},
  ) {
    this.current = state;
    this.crypt = state.ck && state.noncePrefix ? makeEnDecrypt(fromHex(state.noncePrefix), fromHex(state.ck)) : null;
  }

  get state(): TransportState {
    return this.current;
  }

  get messageNumber(): number {
    return this.current.messageNumber;
  }

  private update(patch: Partial<TransportState>): void {
    this.current = { ...this.current, ...patch };
    this.onState(this.current);
  }

  private bumpMsgSeq(): void {
    this.update({ msgSeq: (this.current.msgSeq + 1) & 0xff });
  }
  private bumpNonceSeq(): void {
    this.update({ nonceSeq: this.current.nonceSeq + 1 });
  }
  private bumpMessageNumber(): void {
    this.update({ messageNumber: (this.current.messageNumber + 1) & 0b1111 });
  }

  /** Sends a command message and returns the pod's response message. */
  async sendMessage(message: Message): Promise<Message> {
    const crypt = this.crypt;
    if (!crypt || !this.link.isOpen) throw new OmnipodError('notConnected', 'Pod not connected');

    this.update({ messageNumber: message.sequenceNum });
    this.bumpMessageNumber(); // the response carries the next message number

    this.bumpMsgSeq();
    const wrapped = formatKeys([COMMAND_PREFIX, COMMAND_SUFFIX], [encodeMessage(message), new Uint8Array(0)]);
    this.bumpNonceSeq();
    const packet = crypt.encrypt(
      makePacket({ type: MessageType.ENCRYPTED, source: this.myId, destination: this.podId, payload: wrapped, sequenceNumber: this.current.msgSeq, eqos: 1 }),
      this.current.nonceSeq,
    );

    const sent = await this.link.sendMessagePacket(packet);
    if (sent.kind === 'unsentWithError') throw new OmnipodError('unsent', `Command was not sent: ${errorMessage(sent.error)}`);
    if (sent.kind === 'sentWithError') throw new OmnipodError('unacknowledged', `Command sent, but not acknowledged: ${errorMessage(sent.error)}`);

    try {
      const response = await this.readAndAckResponse(crypt);
      this.bumpMessageNumber();
      return response;
    } catch (e) {
      throw new OmnipodError('unacknowledged', `No valid answer to the command: ${errorMessage(e)}`);
    }
  }

  private async readAndAckResponse(crypt: EnDecrypt): Promise<Message> {
    const received = await this.link.readMessagePacket();
    this.bumpNonceSeq();
    const decrypted = crypt.decrypt(received, this.current.nonceSeq);
    const response = this.parseResponse(decrypted.payload);
    this.bumpMsgSeq();
    this.bumpNonceSeq();
    const ack = crypt.encrypt(
      makePacket({
        type: MessageType.ENCRYPTED,
        source: decrypted.destination,
        destination: decrypted.source,
        payload: new Uint8Array(0),
        sequenceNumber: this.current.msgSeq,
        ack: true,
        ackNumber: (decrypted.sequenceNumber + 1) & 0xff,
        eqos: 0,
      }),
      this.current.nonceSeq,
    );
    const ackResult = await this.link.sendMessagePacket(ack);
    if (ackResult.kind !== 'sentWithAcknowledgment') throw new OmnipodError('protocol', `Could not write ACK: ${ackResult.kind}`);
    if (response.sequenceNum !== this.current.messageNumber) throw new MessageError('Unexpected message sequence number', 'invalidSequence');
    return response;
  }

  private parseResponse(payload: Bytes): Message {
    const data = parseKeys([RESPONSE_PREFIX], payload)[0]!;
    // the CCM tag already authenticates the data, DASH does not check the message CRC
    return decodeMessage(data, false);
  }
}

export const describeTransportState = (s: TransportState): string => `[eapSeq:${s.eapSeq}, msgSeq:${s.msgSeq}, nonceSeq:${s.nonceSeq}, messageNumber:${s.messageNumber}]`;
export const redactKeys = (s: TransportState): TransportState => ({ ...s, ck: s.ck ? '<redacted>' : null, noncePrefix: s.noncePrefix ? '<redacted>' : null });
