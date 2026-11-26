/**
 * Behavioural model of a DASH pod for the protocol simulator (message semantics from OmnipodKit,
 * MIT License, (c) LoopKit Authors): setup progress, immediate boluses
 * with 2 s pulses, basal, temp basal, suspend, reservoir, faults. The model has no radio and no
 * crypto; `simulator.ts` puts it behind the BLE protocol.
 *
 * Simplification: insulin counters only count boluses (prime, cannula insertion, user boluses);
 * scheduled and temp basal delivery are tracked as state but not integrated into the totals.
 */
import type { Millis } from '@buddy/core';
import {
  CancelDeliveryType,
  DeliveryStatus,
  POD,
  PodInfoType,
  PodModel as PodModelType,
  PodProgress,
  faultEventCode,
  makeMessage,
  rateEntryRate,
  tableSegments,
  type CommandBlock,
  type Message,
  type ResponseBlock,
  type StatusResponseBlock,
} from '../common';
import { decodeDetailedStatus, encodeDetailedStatusBody } from '../common';
import type { SetInsulinScheduleBlock } from '../common';

type BolusKind = 'prime' | 'cannula' | 'user';
interface SimBolus {
  readonly kind: BolusKind;
  readonly startedAt: Millis;
  readonly totalPulses: number;
  readonly intervalMs: number;
}
interface SimTemp {
  readonly rate: number;
  readonly startedAt: Millis;
  readonly endsAt: Millis;
}

export interface PodModelOptions {
  readonly now: () => Millis;
  readonly lot?: number;
  readonly tid?: number;
  readonly initialReservoirUnits?: number;
}

/** Message blocks that update the pod's "last programming message sequence number". */
const PROGRAMMING = new Set(['setupPod', 'faultConfig', 'acknowledgeAlert', 'configureAlerts', 'setInsulinSchedule', 'deactivatePod', 'beepConfig', 'cancelDelivery']);

export class PodModel {
  readonly lot: number;
  readonly tid: number;
  progress: PodProgress = PodProgress.initialized;
  activatedAt: Millis | null = null;
  address = 0;
  suspended = false;
  deactivated = false;
  faultCode = 0;
  faultAt: Millis | null = null;
  lastProgrammingSeq = 0;
  alerts = 0;
  /** user boluses started (units), for assertions */
  readonly userBolusRequests: number[] = [];
  /** answers to every command are errors with this code (fault injection) */
  rejectCommands: number | null = null;

  private bolus: SimBolus | null = null;
  private temp: SimTemp | null = null;
  private basalProgrammed = false;
  private completedPulses = 0;
  private completedUserPulses = 0;
  /** pulses of a stopped (cancelled or faulted) bolus that were never delivered; reported until the next bolus */
  private undeliveredAfterStop = 0;
  private reservoirPulses: number;

  constructor(private readonly opts: PodModelOptions) {
    this.lot = opts.lot ?? 135438353;
    this.tid = opts.tid ?? 792407;
    this.reservoirPulses = Math.round((opts.initialReservoirUnits ?? 200) * POD.pulsesPerUnit);
  }

  // ── time ────────────────────────────────────────────────────────────────────

  private pulsesOf(b: SimBolus): number {
    return Math.max(0, Math.min(b.totalPulses, Math.floor((this.opts.now() - b.startedAt) / b.intervalMs)));
  }

  /** Brings the model to `now`: finishes boluses and temp basals, advances the setup progress. */
  sync(): void {
    const now = this.opts.now();
    const b = this.bolus;
    if (b && this.pulsesOf(b) >= b.totalPulses) {
      this.completedPulses += b.totalPulses;
      if (b.kind === 'user') this.completedUserPulses += b.totalPulses;
      this.bolus = null;
      if (b.kind === 'prime') this.progress = PodProgress.primingCompleted;
      if (b.kind === 'cannula') this.progress = this.remainingUnits() > POD.maximumReservoirReading ? PodProgress.aboveFiftyUnits : PodProgress.fiftyOrLessUnits;
    }
    if (this.temp && now >= this.temp.endsAt) this.temp = null;
    if (this.progress === PodProgress.aboveFiftyUnits && this.remainingUnits() <= POD.maximumReservoirReading) this.progress = PodProgress.fiftyOrLessUnits;
  }

  private deliveredPulses(): number {
    return this.completedPulses + (this.bolus ? this.pulsesOf(this.bolus) : 0);
  }

  remainingUnits(): number {
    return Math.max(0, this.reservoirPulses - this.deliveredPulses()) / POD.pulsesPerUnit;
  }

  /** Units delivered as user boluses (ground truth for the PUMP_CONTRACT). */
  get deliveredUserBolusUnits(): number {
    const running = this.bolus?.kind === 'user' ? this.pulsesOf(this.bolus) : 0;
    return (this.completedUserPulses + running) / POD.pulsesPerUnit;
  }

  get isFaulted(): boolean {
    return this.faultCode !== 0;
  }

  injectFault(code: number): void {
    this.sync();
    this.faultCode = code;
    this.faultAt = this.opts.now();
    this.progress = PodProgress.faultEventOccurred;
    this.stopBolus();
    this.temp = null;
  }

  private stopBolus(): void {
    const b = this.bolus;
    if (!b) return;
    const delivered = this.pulsesOf(b);
    this.completedPulses += delivered;
    if (b.kind === 'user') this.completedUserPulses += delivered;
    this.undeliveredAfterStop = b.totalPulses - delivered;
    this.bolus = null;
  }

  // ── status ──────────────────────────────────────────────────────────────────

  private deliveryStatus(): DeliveryStatus {
    if (this.isFaulted || this.suspended || !this.basalProgrammed) return this.bolus ? DeliveryStatus.priming : DeliveryStatus.suspended;
    if (this.bolus && this.temp) return DeliveryStatus.bolusAndTempBasal;
    if (this.bolus) return DeliveryStatus.bolusInProgress;
    if (this.temp) return DeliveryStatus.tempBasalRunning;
    return DeliveryStatus.scheduledBasal;
  }

  timeActiveSeconds(): number {
    return this.activatedAt === null ? 0 : Math.max(0, Math.floor((this.opts.now() - this.activatedAt) / 60000)) * 60;
  }

  status(): StatusResponseBlock {
    this.sync();
    const notDelivered = this.bolus ? this.bolus.totalPulses - this.pulsesOf(this.bolus) : this.undeliveredAfterStop;
    const remaining = this.remainingUnits();
    return {
      type: 'statusResponse',
      deliveryStatus: this.deliveryStatus(),
      podProgress: this.progress,
      timeActive: this.timeActiveSeconds(),
      reservoirLevel: remaining > POD.maximumReservoirReading ? POD.reservoirLevelAboveThresholdMagicNumber : remaining,
      insulinDelivered: this.deliveredPulses() / POD.pulsesPerUnit,
      bolusNotDelivered: notDelivered / POD.pulsesPerUnit,
      lastProgrammingMessageSeqNum: this.lastProgrammingSeq,
      alerts: this.alerts,
    };
  }

  private detailed(): ResponseBlock {
    const s = this.status();
    const body = encodeDetailedStatusBody({
      podProgress: s.podProgress,
      deliveryStatus: this.isFaulted ? DeliveryStatus.suspended : s.deliveryStatus,
      bolusNotDelivered: s.bolusNotDelivered,
      lastProgrammingMessageSeqNum: s.lastProgrammingMessageSeqNum,
      totalInsulinDelivered: s.insulinDelivered,
      faultEventCode: faultEventCode(this.faultCode),
      faultEventTimeSinceActivation: this.faultAt !== null && this.activatedAt !== null ? Math.max(60, Math.floor((this.faultAt - this.activatedAt) / 60000) * 60) : null,
      reservoirLevel: s.reservoirLevel,
      timeActive: s.timeActive,
      unacknowledgedAlerts: s.alerts,
      faultAccessingTables: false,
      errorEventInfo: null,
      receiverLowGain: 0,
      radioRSSI: 0x20,
      possibleFaultCallingAddress: null,
    });
    return { type: 'podInfoResponse', podInfoType: PodInfoType.detailedStatus, info: decodeDetailedStatus(body) };
  }

  // ── commands ────────────────────────────────────────────────────────────────

  private error(code = 0x08): ResponseBlock {
    return { type: 'errorResponse', error: { kind: 'nonretryable', code, faultEventCode: faultEventCode(0), podProgress: this.progress } };
  }

  /** Executes the blocks of one command message and returns the response message. */
  handle(request: Message): Message {
    this.sync();
    const first = request.blocks[0]!;
    const respond = (blocks: ResponseBlock[]): Message => makeMessage(request.address, blocks, (request.sequenceNum + 1) & 0xf);

    if (first.type === 'assignAddress') {
      this.progress = PodProgress.reminderInitialized;
      return respond([
        { type: 'versionResponse', firmwareVersion: '3.27.0', iFirmwareVersion: '8.8.0', podModel: PodModelType.dash, lot: this.lot, tid: this.tid, address: 0xffffffff, podProgress: this.progress, setup: null },
      ]);
    }
    if (first.type === 'setupPod') {
      this.address = first.address;
      this.progress = PodProgress.pairingCompleted;
      this.activatedAt = this.opts.now();
      this.lastProgrammingSeq = request.sequenceNum;
      return respond([
        {
          type: 'versionResponse',
          firmwareVersion: '3.27.0',
          iFirmwareVersion: '8.8.0',
          podModel: PodModelType.dash,
          lot: this.lot,
          tid: this.tid,
          address: first.address,
          podProgress: this.progress,
          setup: { pulseSize: POD.pulseSize, secondsPerBolusPulse: POD.secondsPerBolusPulse, secondsPerPrimePulse: POD.secondsPerPrimePulse, primeUnits: POD.primeUnits, cannulaInsertionUnits: POD.cannulaInsertionUnits, serviceDuration: POD.serviceDuration },
        },
      ]);
    }
    if (this.isFaulted || this.deactivated) return respond([this.detailed()]);
    if (this.rejectCommands !== null && PROGRAMMING.has(first.type)) return respond([this.error(this.rejectCommands)]);

    if (first.type === 'getStatus') {
      if (first.podInfoType === PodInfoType.detailedStatus) return respond([this.detailed()]);
      return respond([this.status()]); // the other info types (pulse logs, alerts) are not simulated
    }

    const accepted = this.execute(request.blocks as CommandBlock[]);
    if (!accepted) return respond([this.error()]);
    if (PROGRAMMING.has(first.type)) this.lastProgrammingSeq = request.sequenceNum;
    return respond([this.status()]);
  }

  /** Returns false when the pod refuses the command. */
  private execute(blocks: readonly CommandBlock[]): boolean {
    const first = blocks[0]!;
    switch (first.type) {
      case 'faultConfig':
      case 'beepConfig':
        return true;
      case 'configureAlerts':
        return true;
      case 'acknowledgeAlert':
        this.alerts &= ~first.alerts;
        return true;
      case 'cancelDelivery':
        return this.cancel(first.deliveryType);
      case 'deactivatePod':
        this.stopBolus();
        this.temp = null;
        this.deactivated = true;
        this.progress = PodProgress.inactive;
        return true;
      case 'setInsulinSchedule':
        return this.program(first, blocks[1]);
      default:
        return false;
    }
  }

  private cancel(type: number): boolean {
    if (type & CancelDeliveryType.bolus) this.stopBolus();
    if (type & CancelDeliveryType.tempBasal) this.temp = null;
    if (type & CancelDeliveryType.basal) {
      this.temp = null;
      this.suspended = true;
    }
    return true;
  }

  private program(cmd: SetInsulinScheduleBlock, extra: CommandBlock | undefined): boolean {
    const s = cmd.schedule;
    const now = this.opts.now();
    if (s.kind === 'bolus') {
      if (extra?.type !== 'bolusExtra' || this.bolus) return false;
      const totalPulses = Math.round(s.units / POD.pulseSize);
      this.undeliveredAfterStop = 0;
      const intervalMs = Math.round(extra.timeBetweenPulses * 1000);
      if (this.progress === PodProgress.pairingCompleted) {
        this.progress = PodProgress.priming;
        this.bolus = { kind: 'prime', startedAt: now, totalPulses, intervalMs };
        return true;
      }
      if (this.progress === PodProgress.basalInitialized) {
        this.progress = PodProgress.insertingCannula;
        this.bolus = { kind: 'cannula', startedAt: now, totalPulses, intervalMs };
        return true;
      }
      if (!(this.progress === PodProgress.aboveFiftyUnits || this.progress === PodProgress.fiftyOrLessUnits) || this.suspended) return false;
      if (totalPulses * POD.pulseSize > POD.maximumBolusUnits + 1e-9 || totalPulses * POD.pulseSize > this.remainingUnits()) return false;
      this.bolus = { kind: 'user', startedAt: now, totalPulses, intervalMs };
      this.userBolusRequests.push(s.units);
      return true;
    }
    if (s.kind === 'tempBasal') {
      if (extra?.type !== 'tempBasalExtra' || this.temp || this.suspended || !this.basalProgrammed) return false;
      const entry = extra.rateEntries[0];
      if (!entry) return false;
      this.temp = { rate: rateEntryRate(entry), startedAt: now, endsAt: now + tableSegments(s.table) * 30 * 60_000 };
      return true;
    }
    if (extra?.type !== 'basalScheduleExtra') return false;
    this.basalProgrammed = true;
    if (this.progress === PodProgress.primingCompleted || this.progress === PodProgress.priming) this.progress = PodProgress.basalInitialized;
    this.suspended = false;
    this.temp = null;
    return true;
  }
}
