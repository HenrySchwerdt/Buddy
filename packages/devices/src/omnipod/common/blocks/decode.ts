/**
 * Decoding of message blocks (the `init(encodedData:)` of `OmnipodCommon/MessageBlocks/*.swift`
 * from OmnipodKit, MIT License, (c) LoopKit Authors). Malformed input throws {@link MessageError}.
 */
import type { Bytes } from '@buddy/core';
import { u16be, u32be } from '../bytes';
import { faultEventCode } from '../fault-codes';
import {
  decodeRateEntry,
  decodeTableEntry,
  fromHundredthsOfMilliseconds,
  type InsulinTableEntry,
} from '../insulin-table';
import { MINUTE, POD, isBeepType, isDeliveryStatus, type AlertSlot, type BeepRepeat, type BeepType, type PodProgress } from '../pod-constants';
import { deliveryScheduleChecksum } from './encode';
import {
  MessageBlockType,
  PodInfoType,
  type AlertConfiguration,
  type DeliverySchedule,
  type DetailedStatus,
  type ErrorEventInfo,
  type MessageBlock,
  type PodInfo,
  type PodInfoResponseBlock,
  type StatusResponseBlock,
  type VersionResponseBlock,
} from './types';

export class MessageError extends Error {
  constructor(
    message: string,
    readonly kind: 'notEnoughData' | 'invalidCrc' | 'invalidSequence' | 'unknownValue' | 'validationFailed' | 'parsingError',
  ) {
    super(message);
    this.name = 'MessageError';
  }
}

const need = (b: Bytes, n: number): void => {
  if (b.length < n) throw new MessageError(`Not enough data: need ${n}, have ${b.length}`, 'notEnoughData');
};
const unknown = (v: number, what: string): never => {
  throw new MessageError(`Unknown value ${v} for ${what}`, 'unknownValue');
};
const progressOf = (v: number): PodProgress => (v >= 0 && v <= 15 ? (v as PodProgress) : unknown(v, 'PodProgress'));

export function decodeStatusResponse(b: Bytes): StatusResponseBlock {
  need(b, 10);
  const delivery = b[1]! >> 4;
  if (!isDeliveryStatus(delivery)) unknown(delivery, 'DeliveryStatus');
  const minutes = ((b[7]! & 0x7f) << 6) + (b[8]! >> 2);
  const insulin = ((b[2]! & 0xf) << 9) | (b[3]! << 1) | (b[4]! >> 7);
  return {
    type: 'statusResponse',
    deliveryStatus: delivery as StatusResponseBlock['deliveryStatus'],
    podProgress: progressOf(b[1]! & 0xf),
    timeActive: minutes * MINUTE,
    insulinDelivered: insulin / POD.pulsesPerUnit,
    lastProgrammingMessageSeqNum: (b[4]! >> 3) & 0xf,
    bolusNotDelivered: (((b[4]! & 0x3) << 8) | b[5]!) / POD.pulsesPerUnit,
    alerts: ((b[6]! & 0x7f) << 1) | (b[7]! >> 7),
    reservoirLevel: (((b[8]! & 0x3) << 8) + b[9]!) / POD.pulsesPerUnit,
  };
}

const version = (b: Bytes, o: number): string => `${b[o]}.${b[o + 1]}.${b[o + 2]}`;

export function decodeVersionResponse(b: Bytes): VersionResponseBlock {
  need(b, 2);
  const length = b[1]!;
  need(b, length + 2);
  if (length === 0x15) {
    return {
      type: 'versionResponse',
      firmwareVersion: version(b, 2),
      iFirmwareVersion: version(b, 5),
      podModel: b[8]!,
      podProgress: progressOf(b[9]!),
      lot: u32be(b, 10),
      tid: u32be(b, 14),
      address: u32be(b, 19),
      setup: null,
    };
  }
  if (length === 0x1b) {
    return {
      type: 'versionResponse',
      firmwareVersion: version(b, 9),
      iFirmwareVersion: version(b, 12),
      podModel: b[15]!,
      podProgress: progressOf(b[16]!),
      lot: u32be(b, 17),
      tid: u32be(b, 21),
      address: u32be(b, 25),
      setup: {
        pulseSize: u16be(b, 2) / 100000,
        secondsPerBolusPulse: b[4]! / 8,
        secondsPerPrimePulse: b[5]! / 8,
        primeUnits: b[6]! / POD.pulsesPerUnit,
        cannulaInsertionUnits: b[7]! / POD.pulsesPerUnit,
        serviceDuration: b[8]! * 3600,
      },
    };
  }
  throw new MessageError(`Unexpected version response length ${length}`, 'parsingError');
}

function decodeErrorResponse(b: Bytes): MessageBlock {
  need(b, 4);
  if (b[2] === 0x14) return { type: 'errorResponse', error: { kind: 'badNonce', nonceResyncKey: u16be(b, 3) } };
  need(b, 5);
  return { type: 'errorResponse', error: { kind: 'nonretryable', code: b[2]!, faultEventCode: faultEventCode(b[3]!), podProgress: progressOf(b[4]!) } };
}

function decodeErrorEventInfo(raw: number): ErrorEventInfo {
  return {
    raw,
    insulinStateTableCorruption: (raw & 0x80) !== 0,
    occlusionType: (raw & 0x60) >> 5,
    immediateBolusInProgress: (raw & 0x10) !== 0,
    podProgress: progressOf(raw & 0xf),
  };
}

export function decodeDetailedStatus(b: Bytes): DetailedStatus {
  need(b, 22);
  const code = faultEventCode(b[8]!);
  const delivery = code.raw !== 0 ? 0 : b[2]! & 0xf;
  if (!isDeliveryStatus(delivery)) unknown(delivery, 'DeliveryStatus');
  const faultTime = u16be(b, 9);
  const info = b[17] === 0 ? null : decodeErrorEventInfo(b[17]!);
  return {
    podInfoType: PodInfoType.detailedStatus,
    podProgress: progressOf(b[1]!),
    deliveryStatus: delivery as DetailedStatus['deliveryStatus'],
    bolusNotDelivered: (((b[3]! & 0x3) << 8) | b[4]!) / POD.pulsesPerUnit,
    lastProgrammingMessageSeqNum: b[5]!,
    totalInsulinDelivered: u16be(b, 6) / POD.pulsesPerUnit,
    faultEventCode: code,
    faultEventTimeSinceActivation: faultTime !== 0xffff && faultTime !== 0 ? faultTime * MINUTE : null,
    reservoirLevel: (((b[11]! & 0x3) << 8) + b[12]!) / POD.pulsesPerUnit,
    timeActive: u16be(b, 13) * MINUTE,
    unacknowledgedAlerts: b[15]!,
    faultAccessingTables: (b[16]! & 2) !== 0,
    errorEventInfo: info,
    receiverLowGain: b[18]! >> 6,
    radioRSSI: b[18]! & 0x3f,
    previousPodProgress: info?.podProgress ?? null,
    possibleFaultCallingAddress: b[8] !== 0 && b[18] === 0 ? u16be(b, 20) : null,
    raw: b.slice(0, 22),
  };
}

export const isFaulted = (d: DetailedStatus): boolean => d.faultEventCode.raw !== 0 || d.podProgress === 14;

function decodePodInfoResponse(b: Bytes): PodInfoResponseBlock {
  need(b, 3);
  const body = b.subarray(2);
  const type = body[0]!;
  let info: PodInfo;
  switch (type) {
    case PodInfoType.detailedStatus:
      info = decodeDetailedStatus(body);
      break;
    case PodInfoType.triggeredAlerts:
      need(body, 11);
      info = { podInfoType: PodInfoType.triggeredAlerts, alertActivations: Array.from({ length: 8 }, (_, i) => u16be(body, 3 + 2 * i) * MINUTE) };
      break;
    case PodInfoType.activationTime:
      need(body, 17);
      info = {
        podInfoType: PodInfoType.activationTime,
        faultEventCode: faultEventCode(body[1]!),
        faultTime: u16be(body, 2) * MINUTE,
        date: { year: body[14]!, month: body[12]!, day: body[13]!, hour: body[15]!, minute: body[16]! },
      };
      break;
    case PodInfoType.normal:
    case PodInfoType.noSeqStatus:
    case PodInfoType.pulseLogPlus:
    case PodInfoType.pulseLogRecent:
    case PodInfoType.pulseLogPrevious:
      info = { podInfoType: type, raw: body.slice() };
      break;
    default:
      return unknown(type, 'PodInfoResponseSubType');
  }
  return { type: 'podInfoResponse', podInfoType: type, info };
}

// ── commands ────────────────────────────────────────────────────────────────

function decodeAlertConfiguration(b: Bytes, o: number): AlertConfiguration {
  need(b, o + 6);
  const yyyy = ((b[o + 2]! << 8) | b[o + 3]!) & 0x3fff;
  const beepRepeat = b[o + 4]!;
  const beepType = b[o + 5]!;
  if (beepRepeat > 8) unknown(beepRepeat, 'BeepRepeat');
  if (!isBeepType(beepType)) unknown(beepType, 'BeepType');
  return {
    slot: (b[o]! >> 4) as AlertSlot,
    active: (b[o]! & 0b1000) !== 0,
    autoOffModifier: (b[o]! & 0b10) !== 0,
    duration: (((b[o]! & 0b1) << 8) + b[o + 1]!) * MINUTE,
    trigger: (b[o]! & 0b100) !== 0 ? { kind: 'unitsRemaining', units: (yyyy * 2) / POD.pulsesPerUnit } : { kind: 'timeUntilAlert', seconds: yyyy * MINUTE },
    beepRepeat: beepRepeat as BeepRepeat,
    beepType: beepType as BeepType,
    silent: beepType === 0xf,
  };
}

function decodeTable(b: Bytes, from: number, length: number): InsulinTableEntry[] {
  const n = Math.trunc((length - 12) / 2);
  return Array.from({ length: n }, (_, i) => decodeTableEntry(b, from + i * 2));
}

function decodeSetInsulinSchedule(b: Bytes): MessageBlock {
  need(b, 14);
  const length = b[1]!;
  need(b, length + 2);
  const nonce = u32be(b, 2);
  const checksum = u16be(b, 7);
  const table = decodeTable(b, 14, length);
  let schedule: DeliverySchedule;
  switch (b[6]) {
    case 0:
      schedule = { kind: 'basalSchedule', currentSegment: b[9]!, secondsRemaining: u16be(b, 10) >> 3, pulsesRemaining: u16be(b, 12), table };
      break;
    case 1:
      schedule = { kind: 'tempBasal', secondsRemaining: u16be(b, 10) >> 3, firstSegmentPulses: u16be(b, 12), table };
      break;
    case 2: {
      const fieldA = u16be(b, 10);
      const unitRate = u16be(b, 12);
      schedule = {
        kind: 'bolus',
        units: (unitRate & 0x03ff) / POD.pulsesPerUnit,
        timeBetweenPulses: unitRate > 0 ? Math.trunc(fieldA / unitRate) / 8 : 0,
        table,
      };
      break;
    }
    default:
      return unknown(b[6]!, 'ScheduleTypeCode');
  }
  if (deliveryScheduleChecksum(schedule) !== checksum) throw new MessageError('InsulinDeliverySchedule checksum failed', 'validationFailed');
  return { type: 'setInsulinSchedule', nonce, schedule };
}

const beeps = (b: Bytes, o: number) => ({
  acknowledgementBeep: (b[o]! & (1 << 7)) !== 0,
  completionBeep: (b[o]! & (1 << 6)) !== 0,
  programReminderInterval: (b[o]! & 0x3f) * MINUTE,
});

function decodeRateEntries(b: Bytes, length: number) {
  const n = Math.trunc((length - 8) / 6);
  return Array.from({ length: n }, (_, i) => decodeRateEntry(b, 10 + i * 6));
}

/** Decodes the block at the start of `data`; returns it with the number of bytes it occupied. */
export function decodeBlock(data: Bytes): { readonly block: MessageBlock; readonly length: number } {
  need(data, 2);
  const type = data[0]!;
  const len = data[1]! + 2;
  const total = (n: number) => {
    need(data, n);
    return n;
  };
  switch (type) {
    case MessageBlockType.statusResponse:
      return { block: decodeStatusResponse(data), length: 10 };
    case MessageBlockType.versionResponse:
      return { block: decodeVersionResponse(data), length: len };
    case MessageBlockType.podInfoResponse:
      return { block: decodePodInfoResponse(data), length: data.length };
    case MessageBlockType.errorResponse:
      return { block: decodeErrorResponse(data), length: data.length };
    case MessageBlockType.getStatus: {
      need(data, 3);
      const t = data[2]!;
      if (!Object.values(PodInfoType).includes(t as never)) unknown(t, 'PodInfoResponseSubType');
      return { block: { type: 'getStatus', podInfoType: t as PodInfoType }, length: 3 };
    }
    case MessageBlockType.assignAddress:
      total(6);
      return { block: { type: 'assignAddress', address: u32be(data, 2) }, length: 6 };
    case MessageBlockType.setupPod: {
      total(21);
      return {
        block: {
          type: 'setupPod',
          address: u32be(data, 2),
          packetTimeoutLimit: data[7]!,
          date: { month: data[8]!, day: data[9]!, year: data[10]! + 2000, hour: data[11]!, minute: data[12]! },
          lot: u32be(data, 13),
          tid: u32be(data, 17),
        },
        length: 21,
      };
    }
    case MessageBlockType.faultConfig:
      total(8);
      return { block: { type: 'faultConfig', nonce: u32be(data, 2), tab5Sub16: data[6]!, tab5Sub17: data[7]! }, length: 8 };
    case MessageBlockType.acknowledgeAlert:
      total(7);
      return { block: { type: 'acknowledgeAlert', nonce: u32be(data, 2), alerts: data[6]! }, length: 7 };
    case MessageBlockType.configureAlerts: {
      total(len);
      const n = Math.trunc((data[1]! - 4) / 6);
      return {
        block: { type: 'configureAlerts', nonce: u32be(data, 2), configurations: Array.from({ length: n }, (_, i) => decodeAlertConfiguration(data, 6 + i * 6)) },
        length: len,
      };
    }
    case MessageBlockType.setInsulinSchedule:
      return { block: decodeSetInsulinSchedule(data), length: len };
    case MessageBlockType.bolusExtra: {
      total(data[1] === 0x12 ? 20 : 15);
      const pulseCountX10 = u16be(data, 9);
      const betweenExtended = fromHundredthsOfMilliseconds(u32be(data, 11));
      return {
        block: {
          type: 'bolusExtra',
          ...beeps(data, 2),
          units: u16be(data, 3) / (POD.pulsesPerUnit * 10),
          timeBetweenPulses: fromHundredthsOfMilliseconds(u32be(data, 5)),
          extendedUnits: pulseCountX10 / (POD.pulsesPerUnit * 10),
          extendedDuration: betweenExtended * (pulseCountX10 / 10),
        },
        length: len,
      };
    }
    case MessageBlockType.tempBasalExtra:
      total(Math.max(14, len));
      return {
        block: {
          type: 'tempBasalExtra',
          ...beeps(data, 2),
          remainingPulses: u16be(data, 4) / 10,
          delayUntilFirstPulse: fromHundredthsOfMilliseconds(u32be(data, 6)),
          rateEntries: decodeRateEntries(data, data[1]!),
        },
        length: len,
      };
    case MessageBlockType.basalScheduleExtra:
      total(Math.max(14, len));
      return {
        block: {
          type: 'basalScheduleExtra',
          ...beeps(data, 2),
          currentEntryIndex: data[3]!,
          remainingPulses: u16be(data, 4) / 10,
          delayUntilNextTenthOfPulse: fromHundredthsOfMilliseconds(u32be(data, 6)),
          rateEntries: decodeRateEntries(data, data[1]!),
        },
        length: len,
      };
    case MessageBlockType.cancelDelivery: {
      total(7);
      const beepType = data[6]! >> 4;
      if (!isBeepType(beepType)) unknown(beepType, 'BeepType');
      return { block: { type: 'cancelDelivery', nonce: u32be(data, 2), deliveryType: data[6]! & 0xf, beepType: beepType as BeepType }, length: 7 };
    }
    case MessageBlockType.deactivatePod:
      total(6);
      return { block: { type: 'deactivatePod', nonce: u32be(data, 2) }, length: 6 };
    case MessageBlockType.beepConfig: {
      total(6);
      if (!isBeepType(data[2]!)) unknown(data[2]!, 'BeepType');
      return {
        block: {
          type: 'beepConfig',
          beepType: data[2] as BeepType,
          basalCompletionBeep: (data[3]! & (1 << 6)) !== 0,
          basalIntervalBeep: (data[3]! & 0x3f) * MINUTE,
          tempBasalCompletionBeep: (data[4]! & (1 << 6)) !== 0,
          tempBasalIntervalBeep: (data[4]! & 0x3f) * MINUTE,
          bolusCompletionBeep: (data[5]! & (1 << 6)) !== 0,
          bolusIntervalBeep: (data[5]! & 0x3f) * MINUTE,
        },
        length: 6,
      };
    }
    default:
      throw new MessageError(`Unknown block type 0x${type.toString(16)}`, 'unknownValue');
  }
}
