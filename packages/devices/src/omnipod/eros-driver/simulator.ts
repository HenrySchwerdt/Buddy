/**
 * Pod-level simulator of an Eros pod behind a RileyLink for tests (original work; message
 * semantics follow OmnipodKit, MIT License, (c) LoopKit Authors). It wires, by composition:
 *
 *   driver -> ErosMessageTransport -> RileyLinkDevice -> fake BLE -> RileyLinkSimulator
 *          -> ErosPodSimulator (radio packets, fragmentation, retries) -> pod behaviour
 *
 * The pod behaviour is the shared DASH `PodModel` (setup progress, immediate boluses, basal,
 * temp basal, suspend, reservoir, faults) plus what is Eros specific: the pod answers with the
 * Eros product id, checks the rolling message nonce of every programming command and answers a
 * wrong nonce with a resync request (the command is NOT executed), exactly like a real pod.
 *
 * Nonce model: the pod expects `current(P)`, accepts a command carrying it and advances `P`.
 * A wrong nonce makes the pod re-seed `P` with a fresh seed that it reports in the sync word.
 *
 * Bench scenario only: the simulated pod holds water and is never attached to anything.
 */
import type { Bytes, Millis } from '@buddy/core';
import {
  PodModel as PodModelId,
  decodeMessage,
  encodeMessage,
  hasNonce,
  makeMessage,
  type MessageBlock,
  type Message,
} from '../common';
import { PodModel } from '../dash/pod-model';
import { advanceNonce, createNonceState, currentNonce, decodePacket, ErosPodSimulator, PacketType, PAIRING_ADDRESS, type NonceState } from '../eros';
import { CRC16_TABLE } from '../eros/crc16';
import { RileyLinkSimulator } from '../../rileylink';

const isAck = (packet: Bytes): boolean => decodePacket(packet).packetType === PacketType.ack;

/** Simulated time one radio attempt takes on the air: an answered one and a silent one (the listen timeout). */
const AIR_HEARD_MS = 5;
const AIR_SILENT_MS = 333;

export interface ErosPodBenchOptions {
  /** Clock of the pod itself (bolus pulses, time since activation). */
  readonly clock: { now(): Millis };
  /** BLE id of the simulated RileyLink. */
  readonly rileyLinkId?: string;
  readonly rileyLinkName?: string;
  readonly lot?: number;
  readonly tid?: number;
  readonly initialReservoirUnits?: number;
  /** First 16-bit nonce seed of the pod. */
  readonly nonceSeed?: number;
}

export class ErosPodBench {
  readonly model: PodModel;
  /** The radio level of the pod (drop / corrupt packets and replies). */
  readonly pod: ErosPodSimulator;
  /** Add this to the fake BLE central. */
  readonly rileyLink: RileyLinkSimulator;
  /** Every complete message the pod received (decoded), executed or not. */
  readonly received: Message[] = [];
  /** Times the pod answered a command with a nonce resync request. */
  badNonceAnswers = 0;
  /** Commands the pod executed. */
  executed = 0;

  private nonce: NonceState;
  private seedCounter = 0;
  private podAddress = 0;
  private heardAddress: number = PAIRING_ADDRESS;
  private forcedBadNonces = 0;
  private ackOnly = 0;
  private repliesLost = false;
  private airTime = 0;
  private readonly baseSeed: number;

  constructor(private readonly opts: ErosPodBenchOptions) {
    this.model = new PodModel({ now: () => opts.clock.now(), lot: opts.lot, tid: opts.tid, initialReservoirUnits: opts.initialReservoirUnits });
    this.baseSeed = opts.nonceSeed ?? 0x1234;
    this.nonce = createNonceState(this.model.lot, this.model.tid, this.baseSeed);
    this.pod = new ErosPodSimulator({
      address: PAIRING_ADDRESS,
      // the pod answers from the address it was addressed on (pairing address until the controller switches)
      get replyAddress() {
        return replyAddressOf();
      },
      onMessage: (bytes) => this.onMessage(bytes),
    });
    const replyAddressOf = () => this.heardAddress;
    this.rileyLink = new RileyLinkSimulator({ id: opts.rileyLinkId ?? 'sim-rileylink-eros', name: opts.rileyLinkName ?? 'RileyLink', onRadio: (tx) => this.air(tx) });
  }

  // ── test controls ───────────────────────────────────────────────────────────

  /** A clock for the driver's radio timeouts: it advances with every over-the-air attempt. */
  readonly airClock = { now: (): Millis => this.airTime };

  /** Ground truth: units of user boluses the pod delivered. */
  get deliveredBolusUnits(): number {
    this.model.sync();
    return this.model.deliveredUserBolusUnits;
  }

  get address(): number {
    return this.podAddress;
  }

  /** Advances the pod to the clock's time. */
  tick(): void {
    this.model.sync();
  }

  injectFault(code: number): void {
    this.model.injectFault(code);
  }

  /** The pod executes commands but its answers never reach the controller (until switched off). */
  loseReplies(on: boolean): void {
    this.repliesLost = on;
  }

  /** The pod re-seeds its nonce state (as if another controller had used it): the next command is rejected once. */
  desyncNonce(): void {
    this.nonce = this.reseed();
  }

  /** The pod rejects the next `n` nonce carrying commands with a resync request, even with a correct nonce. */
  rejectNextNonces(n: number): void {
    this.forcedBadNonces = n;
  }

  /** The pod executes the next `n` messages but only acknowledges them (no answer message). */
  ackOnlyNext(n: number): void {
    this.ackOnly = n;
  }

  // ── radio ───────────────────────────────────────────────────────────────────

  private air(tx: Bytes | null): Bytes | null {
    if (tx && tx.length >= 4) this.heardAddress = new DataView(tx.buffer, tx.byteOffset).getUint32(0);
    let heard = this.pod.respond(tx);
    // lost answers: the pod still acknowledges the request packets (the whole message gets through), but its answer never arrives
    if (heard && this.repliesLost && !isAck(heard)) heard = null;
    this.airTime += heard ? AIR_HEARD_MS : AIR_SILENT_MS;
    return heard;
  }

  // ── pod behaviour ───────────────────────────────────────────────────────────

  private onMessage(bytes: Bytes): Bytes | null {
    let request: Message;
    try {
      request = decodeMessage(bytes);
    } catch {
      return null;
    }
    const first = request.blocks[0]!;
    const pairing = first.type === 'assignAddress' || first.type === 'setupPod';
    if (request.address === PAIRING_ADDRESS ? !pairing : request.address !== this.podAddress) return null;
    this.received.push(request);

    const nonceBlock = request.blocks.find(hasNonce);
    if (nonceBlock && !this.model.isFaulted && !this.model.deactivated) {
      const wrong = this.forcedBadNonces > 0 || nonceBlock.nonce !== currentNonce(this.nonce);
      if (this.forcedBadNonces > 0) this.forcedBadNonces -= 1;
      if (wrong) return encodeMessage(this.badNonce(request, nonceBlock.nonce));
      this.nonce = advanceNonce(this.nonce);
    }

    const response = this.eros(this.model.handle(request), first);
    this.executed += 1;
    if (first.type === 'setupPod') this.podAddress = first.address;
    if (this.ackOnly > 0) {
      this.ackOnly -= 1;
      return null;
    }
    return encodeMessage(response);
  }

  /** What a pod answers to a command with a wrong nonce: the sync word that lets the controller derive the pod's new seed. */
  private badNonce(request: Message, sentNonce: number): Message {
    this.badNonceAnswers += 1;
    const seed = this.reseedSeed();
    this.nonce = createNonceState(this.model.lot, this.model.tid, seed);
    const sum = (sentNonce & 0xffff) + CRC16_TABLE[request.sequenceNum & 0xff]! + (this.model.lot & 0xffff) + (this.model.tid & 0xffff);
    const nonceResyncKey = ((sum & 0xffff) ^ seed) & 0xffff;
    return makeMessage(request.address, [{ type: 'errorResponse', error: { kind: 'badNonce', nonceResyncKey } }], (request.sequenceNum + 1) & 0xf);
  }

  private reseedSeed(): number {
    this.seedCounter += 1;
    return (this.baseSeed + this.seedCounter * 7919) & 0xffff;
  }

  private reseed(): NonceState {
    return createNonceState(this.model.lot, this.model.tid, this.reseedSeed());
  }

  /** The DASH model answers as a DASH pod; an Eros pod reports its own product id and the assigned address. */
  private eros(response: Message, first: MessageBlock): Message {
    return {
      ...response,
      blocks: response.blocks.map((b) =>
        b.type === 'versionResponse' ? { ...b, podModel: PodModelId.eros, address: first.type === 'assignAddress' ? first.address : b.address } : b,
      ),
    };
  }
}
