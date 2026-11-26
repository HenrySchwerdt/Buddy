/**
 * Protocol simulator of an Omnipod DASH pod as a {@link FakePeripheral}: speaks the real BLE
 * protocol of the DASH pod (RTS/CTS flow control, fragmented payloads, X25519/CMAC pairing,
 * EAP-AKA session establishment, AES-CCM encrypted messages) on top of {@link PodModel}, so the
 * driver's framing, crypto, state machine and fault handling run in plain Node tests.
 *
 * It is written from the controller side's point of view of the protocol (OmnipodKit, MIT
 * License, (c) LoopKit Authors), mirrored: it shares the codecs with the driver, but the
 * key derivation, MILENAGE and AES-CCM paths are independently verified against OmnipodKit's
 * test vectors in the test suite.
 */
import type { Bytes, Millis } from '@buddy/core';
import type { FakePeripheral, PeripheralLink } from '../../testkit';
import { concatBytes } from '@buddy/core';
import { decodeMessage, encodeMessage, type Message } from '../common';
import { bytesEqual, randomBytes, u32be } from '../common/bytes';
import { PayloadJoiner, splitPayload } from './ble-packets';
import {
  COMMAND_PREFIX,
  COMMAND_SUFFIX,
  DASH_COMMAND_CHARACTERISTIC,
  DASH_DATA_CHARACTERISTIC,
  DASH_SERVICE_UUID,
  POD_ID_NOT_ACTIVATED,
  PodCommand,
  RESPONSE_PREFIX,
} from './constants';
import { makeEnDecrypt, type EnDecrypt } from './endecrypt';
import { EapAttr, EapCode, SUBTYPE_SYNCHRONIZATION_FAILURE, auts as eapAuts, customIv, encodeEap, findAttribute, parseEap, res as eapRes } from './eap';
import { deriveDashKeysFromSecret, NONCE_SIZE, PUBLIC_KEY_SIZE } from './key-exchange';
import { x25519PublicKey, x25519SharedSecret } from './crypto';
import { encodeMessagePacket, makePacket, MessageType, parseMessagePacket, type MessagePacket } from './message-packet';
import { eapSqnBytes, eapSqnToInt, milenage, RESYNC_AMF } from './milenage';
import { PodModel } from './pod-model';
import { advertisementUuids } from './scan';
import { formatKeys, parseKeys } from './string-prefix';

export interface OmnipodSimulatorOptions {
  readonly clock: { now(): Millis };
  readonly id?: string;
  readonly lot?: number;
  readonly tid?: number;
  readonly initialReservoirUnits?: number;
  /** An already paired pod (skips pairing): its long term key. */
  readonly pairedLtk?: Bytes;
}

interface Session {
  readonly crypt: EnDecrypt;
  readonly ck: Bytes;
  nonceSeq: number;
  pendingAck: boolean;
}

export class OmnipodDashSimulator implements FakePeripheral {
  readonly id: string;
  readonly name: string | null = null;
  readonly mtu = 185;
  readonly model: PodModel;

  private ltk: Bytes | null;
  private controllerId = 0;
  private podId = 0;
  private lastSqn = 0;
  private session: Session | null = null;
  private pairing: { pdmPublic?: Bytes; pdmNonce?: Bytes; podPrivate?: Bytes; podPublic?: Bytes; podNonce?: Bytes; podConf?: Bytes; pdmConf?: Bytes; ltk?: Bytes } = {};
  private rxJoiner: PayloadJoiner | null = null;
  private rxExpected = 0;
  /** outgoing message waiting for the controller's CTS */
  private tx: Bytes[] | null = null;
  private podMsgSeq = 0;
  /** fault injection */
  private dropResponses = 0;
  /** every command message received (decoded), for assertions */
  readonly received: Message[] = [];
  sessionsEstablished = 0;

  constructor(opts: OmnipodSimulatorOptions) {
    this.id = opts.id ?? 'sim-omnipod-dash';
    this.model = new PodModel({ now: () => opts.clock.now(), lot: opts.lot, tid: opts.tid, initialReservoirUnits: opts.initialReservoirUnits });
    this.ltk = opts.pairedLtk ?? null;
  }

  // ── FakePeripheral ──────────────────────────────────────────────────────────

  get serviceUuids(): readonly string[] {
    return advertisementUuids(this.ltk ? this.podId : POD_ID_NOT_ACTIVATED, this.model.lot, this.model.tid);
  }

  onConnect(): void {
    // a new connection starts without session and without half-finished transfers
    this.session = null;
    this.rxJoiner = null;
    this.tx = null;
  }

  onWrite(service: string, characteristic: string, data: Bytes, link: PeripheralLink): void {
    if (service.toLowerCase() !== DASH_SERVICE_UUID) return;
    if (characteristic.toLowerCase() === DASH_COMMAND_CHARACTERISTIC) this.onCommandWrite(data, link);
    else if (characteristic.toLowerCase() === DASH_DATA_CHARACTERISTIC) this.onDataWrite(data, link);
  }

  // ── test controls ───────────────────────────────────────────────────────────

  /** Ground truth: units of user boluses the pod delivered. */
  get deliveredBolusUnits(): number {
    this.model.sync();
    return this.model.deliveredUserBolusUnits;
  }

  /** Advances the pod to the clock's time. */
  tick(): void {
    this.model.sync();
  }

  /** The pod executes the next `n` commands but never answers them (the answer is lost). */
  dropNextResponses(n = 1): void {
    this.dropResponses = n;
  }

  injectFault(code: number): void {
    this.model.injectFault(code);
  }

  // ── BLE flow control ────────────────────────────────────────────────────────

  private notifyCommand(link: PeripheralLink, command: PodCommand): void {
    link.notify(DASH_SERVICE_UUID, DASH_COMMAND_CHARACTERISTIC, new Uint8Array([command]));
  }

  private onCommandWrite(data: Bytes, link: PeripheralLink): void {
    switch (data[0]) {
      case PodCommand.HELLO:
        this.controllerId = u32be(data, 3);
        break;
      case PodCommand.RTS:
        this.rxJoiner = null;
        this.rxExpected = 0;
        this.notifyCommand(link, PodCommand.CTS);
        break;
      case PodCommand.CTS:
        this.flushTx(link);
        break;
      case PodCommand.SUCCESS:
      case PodCommand.NACK:
        this.tx = null;
        break;
      default:
        break;
    }
  }

  private flushTx(link: PeripheralLink): void {
    const packets = this.tx;
    if (!packets) return;
    for (const p of packets) link.notify(DASH_SERVICE_UUID, DASH_DATA_CHARACTERISTIC, p);
  }

  private onDataWrite(data: Bytes, link: PeripheralLink): void {
    try {
      if (!this.rxJoiner) {
        this.rxJoiner = new PayloadJoiner(data);
        this.rxExpected = 0;
      } else {
        this.rxExpected += 1;
        this.rxJoiner.accumulate(data);
      }
      const j = this.rxJoiner;
      // the number of packets is known from the first one, or (for long messages) from the last
      if (this.rxExpected < j.fullFragments + (j.oneExtraPacket ? 1 : 0)) return;
      const payload = j.finalize();
      this.rxJoiner = null;
      this.notifyCommand(link, PodCommand.SUCCESS);
      this.onMessage(parseMessagePacket(payload), link);
    } catch {
      this.rxJoiner = null;
      this.notifyCommand(link, PodCommand.NACK);
    }
  }

  private send(packet: MessagePacket, link: PeripheralLink): void {
    this.tx = splitPayload(encodeMessagePacket(packet));
    this.notifyCommand(link, PodCommand.RTS);
  }

  // ── messages ────────────────────────────────────────────────────────────────

  private onMessage(msg: MessagePacket, link: PeripheralLink): void {
    switch (msg.type) {
      case MessageType.PAIRING:
        this.onPairing(msg, link);
        break;
      case MessageType.SESSION_ESTABLISHMENT:
        this.onSessionEstablishment(msg, link);
        break;
      case MessageType.ENCRYPTED:
        this.onEncrypted(msg, link);
        break;
      default:
        break;
    }
  }

  private reply(type: MessageType, payload: Bytes, link: PeripheralLink, seq?: number): void {
    this.podMsgSeq = (this.podMsgSeq + 1) & 0xff;
    this.send(makePacket({ type, source: this.podId || POD_ID_NOT_ACTIVATED, destination: this.controllerId, payload, sequenceNumber: seq ?? this.podMsgSeq }), link);
  }

  // ── pairing (SP1/SP2, SPS1, SPS2, SP0GP0) ───────────────────────────────────

  private onPairing(msg: MessagePacket, link: PeripheralLink): void {
    if (this.ltk && !this.pairing.ltk) return; // paired pods ignore pairing attempts
    const text = new TextDecoder().decode(msg.payload.slice(0, 7));
    if (text.startsWith('SP1=')) {
      const [podId] = parseKeys(['SP1=', ',SP2='], msg.payload);
      this.podId = u32be(podId!, 0);
    } else if (text.startsWith('SPS1=')) {
      const body = parseKeys(['SPS1='], msg.payload)[0]!;
      const pdmPublic = body.slice(0, PUBLIC_KEY_SIZE);
      const pdmNonce = body.slice(PUBLIC_KEY_SIZE, PUBLIC_KEY_SIZE + NONCE_SIZE);
      const podPrivate = randomBytes(32);
      const podPublic = x25519PublicKey(podPrivate);
      const podNonce = randomBytes(NONCE_SIZE);
      const keys = deriveDashKeysFromSecret(x25519SharedSecret(podPrivate, pdmPublic), pdmPublic, pdmNonce, podPublic, podNonce);
      this.pairing = { pdmPublic, pdmNonce, podPrivate, podPublic, podNonce, podConf: keys.podConf, pdmConf: keys.pdmConf, ltk: keys.ltk };
      this.reply(MessageType.PAIRING, formatKeys(['SPS1='], [concatBytes(podPublic, podNonce)]), link);
    } else if (text.startsWith('SPS2=')) {
      const conf = parseKeys(['SPS2='], msg.payload)[0]!;
      if (!this.pairing.pdmConf || !bytesEqual(conf, this.pairing.pdmConf)) return; // wrong confirmation: stay silent
      this.reply(MessageType.PAIRING, formatKeys(['SPS2='], [this.pairing.podConf!]), link);
    } else if (text.startsWith('SP0,GP0')) {
      this.ltk = this.pairing.ltk ?? null;
      this.lastSqn = 0;
      this.reply(MessageType.PAIRING, formatKeys(['P0='], [new Uint8Array([0xa5])]), link);
    }
  }

  // ── session establishment (EAP-AKA) ─────────────────────────────────────────

  private onSessionEstablishment(msg: MessagePacket, link: PeripheralLink): void {
    if (!this.ltk) return;
    const eap = parseEap(msg.payload);
    if (eap.code === EapCode.SUCCESS || eap.code === EapCode.FAILURE) return;
    if (eap.code !== EapCode.REQUEST) return;
    const randAttr = findAttribute(eap, EapAttr.RAND);
    const autnAttr = findAttribute(eap, EapAttr.AUTN);
    const ivAttr = findAttribute(eap, EapAttr.CUSTOM_IV);
    if (!randAttr || !autnAttr || !ivAttr) return;
    const rand = randAttr.payload;
    // recover the controller's SQN from AUTN = (SQN xor AK) || AMF || MAC-A and verify the MAC
    const probe = milenage({ k: this.ltk, rand, sqn: new Uint8Array(6) });
    const sqn = autnAttr.payload.slice(0, 6).map((v, i) => v ^ probe.ak[i]!);
    const m = milenage({ k: this.ltk, rand, sqn });
    if (!bytesEqual(m.autn, autnAttr.payload)) return; // not our LTK: no answer
    const sqnValue = eapSqnToInt(sqn);
    if (sqnValue <= this.lastSqn) {
      // stale sequence number: ask for a resynchronisation with our SQN
      const podSqn = eapSqnBytes(this.lastSqn);
      const r = milenage({ k: this.ltk, rand, sqn: podSqn, amf: RESYNC_AMF });
      const authValue = concatBytes(r.akStar.map((v, i) => v ^ podSqn[i]!), r.macS);
      this.reply(MessageType.SESSION_ESTABLISHMENT, encodeEap({ code: EapCode.RESPONSE, identifier: eap.identifier, subType: SUBTYPE_SYNCHRONIZATION_FAILURE, attributes: [eapAuts(authValue)] }), link, msg.sequenceNumber);
      return;
    }
    this.lastSqn = sqnValue;
    const nodeIV = randomBytes(4);
    const noncePrefix = concatBytes(ivAttr.payload.slice(0, 4), nodeIV);
    this.session = { crypt: makeEnDecrypt(noncePrefix, m.ck, false), ck: m.ck, nonceSeq: 0, pendingAck: false };
    this.sessionsEstablished += 1;
    this.reply(MessageType.SESSION_ESTABLISHMENT, encodeEap({ code: EapCode.RESPONSE, identifier: eap.identifier, subType: 0, attributes: [eapRes(m.res), customIv(nodeIV)] }), link, msg.sequenceNumber);
  }

  // ── encrypted commands ──────────────────────────────────────────────────────

  private onEncrypted(msg: MessagePacket, link: PeripheralLink): void {
    const s = this.session;
    if (!s) return;
    s.nonceSeq += 1;
    let plain: MessagePacket;
    try {
      plain = s.crypt.decrypt(msg, s.nonceSeq);
    } catch {
      link.disconnect(new Error('Pod could not authenticate the message'));
      return;
    }
    if (msg.ack) {
      s.pendingAck = false; // the controller's acknowledgement of our response
      return;
    }
    let command: Message;
    try {
      command = decodeMessage(parseKeys([COMMAND_PREFIX, COMMAND_SUFFIX], plain.payload)[0]!);
    } catch {
      return;
    }
    this.received.push(command);
    const response = this.model.handle(command);
    if (this.dropResponses > 0) {
      this.dropResponses -= 1;
      s.nonceSeq += 2; // the answer and the acknowledgement that never happen
      return;
    }
    s.nonceSeq += 1;
    s.pendingAck = true;
    this.podMsgSeq = (this.podMsgSeq + 1) & 0xff;
    const wrapped = formatKeys([RESPONSE_PREFIX], [encodeMessage(response)]);
    const encrypted = s.crypt.encrypt(
      makePacket({ type: MessageType.ENCRYPTED, source: this.podId, destination: this.controllerId, payload: wrapped, sequenceNumber: this.podMsgSeq, eqos: 1 }),
      s.nonceSeq,
    );
    this.send(encrypted, link);
    if (this.model.deactivated) setTimeout(() => link.disconnect(), 5);
  }
}
