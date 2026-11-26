/**
 * Command layer of a DASH session: builds the message blocks, sends them through the encrypted
 * transport and checks the pod's answer. Port of `PumpManager/PodCommsSession.swift` and the
 * DASH parts of `Bluetooth/BlePodComms.swift` from OmnipodKit (MIT License, (c) LoopKit Authors).
 *
 * DELIBERATELY NOT PORTED: nonce resynchronisation (Eros only; DASH uses a fixed nonce), beep
 * blocks appended to commands, pulse log reading, suspend reminder alerts.
 */
import {
  DASH_FIXED_NONCE,
  MINUTE,
  PodInfoType,
  POD,
  BeepType,
  basalScheduleBlocks,
  bolusScheduleBlocks,
  faultFromDetailed,
  formatFault,
  makeMessage,
  messageFault,
  tempBasalBlocks,
  type AlertConfiguration,
  type AlertSet,
  type BasalSchedule,
  type CommandBlock,
  type DetailedStatus,
  type Message,
  type ResponseBlock,
  type StatusResponseBlock,
  type VersionResponseBlock,
} from '../common';
import { OmnipodError } from './errors';
import type { PodMessageTransport } from './transport';

export const DASH_ZERO_BASAL_RATE = POD.nearZeroBasalRate;
const BROADCAST_ADDRESS = 0xffffffff;

type Expect = ResponseBlock['type'];
type ResponseOf<K extends Expect> = Extract<ResponseBlock, { type: K }>;

export class PodComms {
  constructor(
    readonly transport: PodMessageTransport,
    /** the pod's own address (0xffffffff while pairing) */
    private readonly address: number,
  ) {}

  /** The message number the next command will use. */
  get messageNumber(): number {
    return this.transport.messageNumber;
  }

  /** Sends one message and returns its first block if it is the expected response. */
  async send<K extends Expect>(blocks: readonly CommandBlock[], expect: K, opts: { address?: number } = {}): Promise<ResponseOf<K>> {
    const message = makeMessage(opts.address ?? this.address, blocks, this.transport.messageNumber);
    const response = await this.transport.sendMessage(message);
    return this.expect(response, expect);
  }

  private expect<K extends Expect>(response: Message, expect: K): ResponseOf<K> {
    const first = response.blocks[0];
    if (first?.type === expect) return first as ResponseOf<K>;
    const detailed = messageFault(response);
    if (detailed) throw new OmnipodError('podFault', `Pod fault: ${formatFault(detailed.faultEventCode)}`, faultFromDetailed(detailed));
    if (first?.type === 'errorResponse') {
      const e = first.error;
      if (e.kind === 'nonretryable') throw new OmnipodError('rejected', `Pod rejected the command (error ${e.code}, ${formatFault(e.faultEventCode)})`);
      throw new OmnipodError('rejected', 'Pod reported a nonce mismatch, which DASH pods do not use');
    }
    throw new OmnipodError('protocol', `Unexpected response from pod: ${first?.type ?? 'empty message'}`);
  }

  // ── pairing messages (broadcast address) ────────────────────────────────────

  assignAddress(): Promise<VersionResponseBlock> {
    return this.send([{ type: 'assignAddress', address: BROADCAST_ADDRESS }], 'versionResponse', { address: BROADCAST_ADDRESS });
  }

  setupPod(p: { address: number; lot: number; tid: number; date: { year: number; month: number; day: number; hour: number; minute: number } }): Promise<VersionResponseBlock> {
    return this.send([{ type: 'setupPod', address: p.address, lot: p.lot, tid: p.tid, date: p.date, packetTimeoutLimit: 4 }], 'versionResponse', { address: BROADCAST_ADDRESS });
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
    return this.send([{ type: 'faultConfig', nonce: DASH_FIXED_NONCE, tab5Sub16: 0, tab5Sub17: 0 }], 'statusResponse');
  }

  configureAlerts(configurations: readonly AlertConfiguration[], acknowledgeAll = false): Promise<StatusResponseBlock> {
    const blocks: CommandBlock[] = [];
    if (acknowledgeAll) blocks.push({ type: 'acknowledgeAlert', nonce: DASH_FIXED_NONCE, alerts: 0xff });
    blocks.push({ type: 'configureAlerts', nonce: DASH_FIXED_NONCE, configurations });
    return this.send(blocks, 'statusResponse');
  }

  acknowledgeAlerts(alerts: AlertSet): Promise<StatusResponseBlock> {
    return this.send([{ type: 'acknowledgeAlert', nonce: DASH_FIXED_NONCE, alerts }], 'statusResponse');
  }

  /** Priming and cannula insertion deliver at 1 pulse per second. */
  setupBolus(units: number): Promise<StatusResponseBlock> {
    return this.send(bolusScheduleBlocks(DASH_FIXED_NONCE, units, POD.secondsPerPrimePulse), 'statusResponse');
  }

  // ── delivery ────────────────────────────────────────────────────────────────

  bolus(units: number): Promise<StatusResponseBlock> {
    return this.send(bolusScheduleBlocks(DASH_FIXED_NONCE, units, POD.secondsPerBolusPulse), 'statusResponse');
  }

  setTempBasal(rate: number, durationMinutes: number): Promise<StatusResponseBlock> {
    return this.send(tempBasalBlocks(DASH_FIXED_NONCE, rate, durationMinutes * MINUTE, DASH_ZERO_BASAL_RATE), 'statusResponse');
  }

  setBasalSchedule(schedule: BasalSchedule, scheduleOffsetSeconds: number): Promise<StatusResponseBlock> {
    return this.send(basalScheduleBlocks(DASH_FIXED_NONCE, schedule, scheduleOffsetSeconds, DASH_ZERO_BASAL_RATE), 'statusResponse');
  }

  cancelDelivery(deliveryType: number): Promise<StatusResponseBlock> {
    return this.send([{ type: 'cancelDelivery', nonce: DASH_FIXED_NONCE, deliveryType, beepType: BeepType.noBeepCancel }], 'statusResponse');
  }

  deactivate(): Promise<StatusResponseBlock> {
    return this.send([{ type: 'deactivatePod', nonce: DASH_FIXED_NONCE }], 'statusResponse');
  }
}
