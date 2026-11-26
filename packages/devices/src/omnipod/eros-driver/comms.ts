/**
 * Command layer of an Eros session: builds the message blocks, runs them through the
 * `ErosMessageTransport`, handles the rolling message nonce (including the resync after a
 * `badNonce` answer) and checks the pod's answer. Port of `PodCommsSession.send` and the command
 * functions of `PumpManager/PodCommsSession.swift` plus `NonceState` handling of `PodState.swift`
 * (OmnipodKit, MIT License, (c) LoopKit Authors).
 *
 * Nonce semantics follow OmnipodKit exactly: the command is built with the current nonce, the
 * state is advanced when the message is sent, and after a resync the new current nonce replaces
 * the rejected one before the state is advanced again. Nonces and seeds are never logged.
 */
import { type Bytes } from '@buddy/core';
import {
  DASH_FIXED_NONCE,
  MINUTE,
  PodInfoType,
  POD,
  BeepType,
  basalScheduleBlocks,
  bolusScheduleBlocks,
  decodeMessage,
  encodeMessage,
  faultFromDetailed,
  formatFault,
  hasNonce,
  makeMessage,
  messageFault,
  tempBasalBlocks,
  type AlertConfiguration,
  type AlertSet,
  type BasalSchedule,
  type CommandBlock,
  type DetailedStatus,
  type Message,
  type MessageBlock,
  type ResponseBlock,
  type StatusResponseBlock,
} from '../common';
import { advanceNonce, currentNonce, resyncNonceState, type ErosMessageTransport } from '../eros';
import { errorMessage, fromRadioError, OmnipodError } from './errors';
import type { NonceHolder } from './nonce-store';

/** Eros pods support a true zero temp basal; scheduled basal is raised to one pulse per hour. */
export const EROS_ZERO_BASAL_RATE = 0;
const MAX_SEND_TRIES = 2; // retries happen for nonce resync only

type Expect = ResponseBlock['type'];
type ResponseOf<K extends Expect> = Extract<ResponseBlock, { type: K }>;

/** Sends one complete message and decodes the pod's answer. Radio errors become `OmnipodError`s. */
export async function exchangeMessage(transport: ErosMessageTransport, message: Message): Promise<Message> {
  let bytes: Bytes;
  try {
    bytes = await transport.sendMessage(encodeMessage(message));
  } catch (e) {
    throw fromRadioError(e);
  }
  try {
    return decodeMessage(bytes);
  } catch (e) {
    // the pod answered, so the command may have run
    throw new OmnipodError('unacknowledged', `Unreadable answer from the pod: ${errorMessage(e)}`);
  }
}

const withNonce = (blocks: readonly CommandBlock[], nonce: number): CommandBlock[] => blocks.map((b) => (hasNonce(b) ? { ...b, nonce } : b));
const sentNonceOf = (blocks: readonly MessageBlock[]): number | null => {
  const b = blocks.find(hasNonce);
  return b && hasNonce(b) ? b.nonce : null;
};

export class ErosPodComms {
  constructor(
    readonly transport: ErosMessageTransport,
    /** the pod's radio address */
    private readonly address: number,
    private readonly nonce: NonceHolder,
    private readonly identity: { readonly lot: number; readonly tid: number },
  ) {}

  /** The message number the next command will use. */
  get messageNumber(): number {
    return this.transport.messageNumber;
  }

  private nonceNow(): number {
    const s = this.nonce.get();
    return s ? currentNonce(s) : DASH_FIXED_NONCE; // OmnipodKit: without a nonce state the first command is rejected and resyncs
  }

  private advance(): void {
    const s = this.nonce.get();
    if (s) this.nonce.set(advanceNonce(s));
  }

  /** Sends the blocks as one message and returns the first block if it is the expected response. */
  async send<K extends Expect>(blocks: readonly CommandBlock[], expect: K): Promise<ResponseOf<K>> {
    const nonceBlocks = blocks.some(hasNonce);
    let toSend: CommandBlock[] = nonceBlocks ? withNonce(blocks, this.nonceNow()) : [...blocks];
    if (nonceBlocks) this.advance();
    const messageNumber = this.transport.messageNumber;

    for (let tries = MAX_SEND_TRIES; tries > 0; tries--) {
      const sentNonce = sentNonceOf(toSend);
      const response = await exchangeMessage(this.transport, makeMessage(this.address, toSend, messageNumber));
      const first = response.blocks[0];
      if (first?.type === expect) return first as ResponseOf<K>;
      const detailed = messageFault(response);
      if (detailed) throw new OmnipodError('podFault', `Pod fault: ${formatFault(detailed.faultEventCode)}`, faultFromDetailed(detailed));
      if (first?.type !== 'errorResponse') throw new OmnipodError('protocol', `Unexpected response from pod: ${first?.type ?? 'empty message'}`);
      const e = first.error;
      if (e.kind === 'nonretryable') throw new OmnipodError('rejected', `Pod rejected the command (error ${e.code}, ${formatFault(e.faultEventCode)})`);
      if (sentNonce === null) throw new OmnipodError('protocol', 'Unexpected bad nonce answer to a command without nonce');
      // The pod did not execute the command: re-seed and send it again with the new nonce.
      this.nonce.set(resyncNonceState({ ...this.identity, syncWord: e.nonceResyncKey, sentNonce, messageSequenceNum: messageNumber }));
      toSend = withNonce(toSend, this.nonceNow());
      this.advance();
    }
    throw new OmnipodError('rejected', 'Nonce resync failed');
  }

  // ── status ──────────────────────────────────────────────────────────────────

  getStatus(): Promise<StatusResponseBlock> {
    return this.send([{ type: 'getStatus', podInfoType: PodInfoType.normal }], 'statusResponse');
  }

  async getDetailedStatus(): Promise<DetailedStatus> {
    const r = await this.send([{ type: 'getStatus', podInfoType: PodInfoType.detailedStatus }], 'podInfoResponse');
    if (r.info.podInfoType !== PodInfoType.detailedStatus) throw new OmnipodError('protocol', 'Expected a detailed status');
    return r.info;
  }

  // ── setup ───────────────────────────────────────────────────────────────────

  faultConfig(): Promise<StatusResponseBlock> {
    return this.send([{ type: 'faultConfig', nonce: 0, tab5Sub16: 0, tab5Sub17: 0 }], 'statusResponse');
  }

  configureAlerts(configurations: readonly AlertConfiguration[], acknowledgeAll = false): Promise<StatusResponseBlock> {
    const blocks: CommandBlock[] = [];
    if (acknowledgeAll) blocks.push({ type: 'acknowledgeAlert', nonce: 0, alerts: 0xff });
    blocks.push({ type: 'configureAlerts', nonce: 0, configurations });
    return this.send(blocks, 'statusResponse');
  }

  acknowledgeAlerts(alerts: AlertSet): Promise<StatusResponseBlock> {
    return this.send([{ type: 'acknowledgeAlert', nonce: 0, alerts }], 'statusResponse');
  }

  /** Priming and cannula insertion deliver at 1 pulse per second. */
  setupBolus(units: number): Promise<StatusResponseBlock> {
    return this.send(bolusScheduleBlocks(0, units, POD.secondsPerPrimePulse), 'statusResponse');
  }

  // ── delivery ────────────────────────────────────────────────────────────────

  bolus(units: number): Promise<StatusResponseBlock> {
    return this.send(bolusScheduleBlocks(0, units, POD.secondsPerBolusPulse), 'statusResponse');
  }

  setTempBasal(rate: number, durationMinutes: number): Promise<StatusResponseBlock> {
    return this.send(tempBasalBlocks(0, rate, durationMinutes * MINUTE, EROS_ZERO_BASAL_RATE), 'statusResponse');
  }

  setBasalSchedule(schedule: BasalSchedule, scheduleOffsetSeconds: number): Promise<StatusResponseBlock> {
    return this.send(basalScheduleBlocks(0, schedule, scheduleOffsetSeconds, EROS_ZERO_BASAL_RATE), 'statusResponse');
  }

  cancelDelivery(deliveryType: number): Promise<StatusResponseBlock> {
    return this.send([{ type: 'cancelDelivery', nonce: 0, deliveryType, beepType: BeepType.noBeepCancel }], 'statusResponse');
  }

  deactivate(): Promise<StatusResponseBlock> {
    return this.send([{ type: 'deactivatePod', nonce: 0 }], 'statusResponse');
  }
}
