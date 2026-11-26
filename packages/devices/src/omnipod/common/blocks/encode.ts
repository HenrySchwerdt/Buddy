/**
 * Encoding of message blocks (the `data` getters of `OmnipodCommon/MessageBlocks/*.swift` from
 * OmnipodKit, MIT License, (c) LoopKit Authors). The response encoders exist for the protocol
 * simulators and tests; a controller only ever sends commands.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { be16, be32 } from '../bytes';
import {
  encodeRateEntry,
  encodeTableEntry,
  hundredthsOfMilliseconds,
  tableEntryChecksum,
  tableSegments,
} from '../insulin-table';
import { MINUTE, POD } from '../pod-constants';
import { MessageBlockType, PodInfoType, type AlertConfiguration, type BeepOptions, type DeliverySchedule, type DetailedStatus, type MessageBlock, type StatusResponseBlock } from './types';

const beepOptions = (o: BeepOptions): number =>
  (Math.trunc(o.programReminderInterval / MINUTE) & 0x3f) + (o.completionBeep ? 1 << 6 : 0) + (o.acknowledgementBeep ? 1 << 7 : 0);

const u8 = (...v: number[]): Bytes => new Uint8Array(v.map((x) => x & 0xff));

export function encodeAlertConfiguration(c: AlertConfiguration): Bytes {
  let first = c.slot << 4;
  first += c.active ? 1 << 3 : 0;
  if (c.trigger.kind === 'unitsRemaining') first += 1 << 2;
  if (c.autoOffModifier) first += 1 << 1;
  const durationMinutes = Math.min(Math.trunc(c.duration / MINUTE), 0x1ff);
  first += (durationMinutes >> 8) & 0x1;
  const trigger =
    c.trigger.kind === 'unitsRemaining'
      ? be16(Math.trunc(c.trigger.units / POD.pulseSize / 2))
      : be16(Math.trunc((c.trigger.seconds + 30) / MINUTE));
  return concatBytes(u8(first, durationMinutes & 0xff), trigger, u8(c.beepRepeat, c.silent ? 0xf : c.beepType));
}

function deliveryScheduleData(s: DeliverySchedule): Bytes {
  switch (s.kind) {
    case 'basalSchedule':
      return concatBytes(u8(s.currentSegment), be16((s.secondsRemaining << 3) & 0xffff), be16(s.pulsesRemaining), ...s.table.map(encodeTableEntry));
    case 'tempBasal':
      return concatBytes(u8(tableSegments(s.table)), be16((s.secondsRemaining << 3) & 0xffff), be16(s.firstSegmentPulses), ...s.table.map(encodeTableEntry));
    case 'bolus': {
      const firstSegmentPulses = Math.round(s.units / POD.pulseSize);
      const multiplier = Math.round(s.timeBetweenPulses * 8);
      const fieldA = firstSegmentPulses * multiplier;
      if (fieldA > 0xffff) throw new Error('Bolus too large for the delivery schedule field');
      return concatBytes(u8(tableSegments(s.table)), be16(fieldA), be16(firstSegmentPulses), ...s.table.map(encodeTableEntry));
    }
  }
}

const scheduleTypeCode = (s: DeliverySchedule): number => (s.kind === 'basalSchedule' ? 0 : s.kind === 'tempBasal' ? 1 : 2);

export function deliveryScheduleChecksum(s: DeliverySchedule): number {
  const head = deliveryScheduleData(s).subarray(0, 5).reduce((a, b) => a + b, 0);
  return (head + s.table.reduce((a, e) => a + tableEntryChecksum(e), 0)) & 0xffff;
}

export function encodeStatusResponse(s: StatusResponseBlock): Bytes {
  const insulin = Math.round(s.insulinDelivered * POD.pulsesPerUnit);
  const notDelivered = Math.round(s.bolusNotDelivered * POD.pulsesPerUnit);
  const reservoir = Math.round(s.reservoirLevel * POD.pulsesPerUnit);
  const minutes = Math.trunc(s.timeActive / MINUTE);
  return u8(
    MessageBlockType.statusResponse,
    (s.deliveryStatus << 4) | s.podProgress,
    (insulin >> 9) & 0xf,
    (insulin >> 1) & 0xff,
    ((insulin & 1) << 7) | ((s.lastProgrammingMessageSeqNum & 0xf) << 3) | ((notDelivered >> 8) & 0x3),
    notDelivered & 0xff,
    (s.alerts >> 1) & 0x7f,
    ((s.alerts & 1) << 7) | ((minutes >> 6) & 0x7f),
    ((minutes & 0x3f) << 2) | ((reservoir >> 8) & 0x3),
    reservoir & 0xff,
  );
}

/** The 22 byte detailed status body (starting with the pod info type byte). */
export function encodeDetailedStatusBody(d: Omit<DetailedStatus, 'raw' | 'podInfoType' | 'previousPodProgress'>): Bytes {
  const notDelivered = Math.round(d.bolusNotDelivered * POD.pulsesPerUnit);
  const reservoir = Math.round(d.reservoirLevel * POD.pulsesPerUnit);
  const total = Math.round(d.totalInsulinDelivered * POD.pulsesPerUnit);
  const faultTime = d.faultEventTimeSinceActivation === null ? 0xffff : Math.trunc(d.faultEventTimeSinceActivation / MINUTE);
  const info = d.errorEventInfo?.raw ?? 0;
  return concatBytes(
    u8(PodInfoType.detailedStatus, d.podProgress, d.deliveryStatus & 0xf, (notDelivered >> 8) & 0x3, notDelivered & 0xff, d.lastProgrammingMessageSeqNum),
    be16(total),
    u8(d.faultEventCode.raw),
    be16(faultTime),
    u8((reservoir >> 8) & 0x3, reservoir & 0xff),
    be16(Math.trunc(d.timeActive / MINUTE)),
    u8(d.unacknowledgedAlerts, d.faultAccessingTables ? 2 : 0, info, (d.receiverLowGain << 6) | (d.radioRSSI & 0x3f), 0),
    be16(d.possibleFaultCallingAddress ?? 0),
  );
}

export function encodeBlock(b: MessageBlock): Bytes {
  switch (b.type) {
    case 'getStatus':
      return u8(MessageBlockType.getStatus, 1, b.podInfoType);
    case 'assignAddress':
      return concatBytes(u8(MessageBlockType.assignAddress, 4), be32(b.address));
    case 'setupPod':
      return concatBytes(
        u8(MessageBlockType.setupPod, 19),
        be32(b.address),
        u8(0x14, b.packetTimeoutLimit, b.date.month, b.date.day, b.date.year - 2000, b.date.hour, b.date.minute),
        be32(b.lot),
        be32(b.tid),
      );
    case 'faultConfig':
      return concatBytes(u8(MessageBlockType.faultConfig, 6), be32(b.nonce), u8(b.tab5Sub16, b.tab5Sub17));
    case 'acknowledgeAlert':
      return concatBytes(u8(MessageBlockType.acknowledgeAlert, 5), be32(b.nonce), u8(b.alerts));
    case 'configureAlerts': {
      const sorted = [...b.configurations].sort((a, c) => a.slot - c.slot);
      return concatBytes(u8(MessageBlockType.configureAlerts, 4 + sorted.length * 6), be32(b.nonce), ...sorted.map(encodeAlertConfiguration));
    }
    case 'setInsulinSchedule': {
      const data = deliveryScheduleData(b.schedule);
      return concatBytes(u8(MessageBlockType.setInsulinSchedule, 7 + data.length), be32(b.nonce), u8(scheduleTypeCode(b.schedule)), be16(deliveryScheduleChecksum(b.schedule)), data);
    }
    case 'bolusExtra': {
      const pulseCountX10 = Math.round(b.extendedUnits * POD.pulsesPerUnit * 10);
      const betweenExtended = pulseCountX10 > 0 ? b.extendedDuration / (pulseCountX10 / 10) : 0;
      return concatBytes(
        u8(MessageBlockType.bolusExtra, 0x0d, beepOptions(b)),
        be16(Math.round(b.units * POD.pulsesPerUnit * 10)),
        be32(Math.trunc(hundredthsOfMilliseconds(b.timeBetweenPulses))),
        be16(pulseCountX10),
        be32(Math.trunc(hundredthsOfMilliseconds(betweenExtended))),
      );
    }
    case 'tempBasalExtra':
      return concatBytes(
        u8(MessageBlockType.tempBasalExtra, 8 + b.rateEntries.length * 6, beepOptions(b), 0),
        be16(Math.round(b.remainingPulses * 10)),
        be32(Math.trunc(hundredthsOfMilliseconds(b.delayUntilFirstPulse))),
        ...b.rateEntries.map(encodeRateEntry),
      );
    case 'basalScheduleExtra':
      return concatBytes(
        u8(MessageBlockType.basalScheduleExtra, 8 + b.rateEntries.length * 6, beepOptions(b), b.currentEntryIndex),
        be16(Math.round(b.remainingPulses * 10)),
        be32(Math.round(b.delayUntilNextTenthOfPulse * 1000 * 1000)),
        ...b.rateEntries.map(encodeRateEntry),
      );
    case 'cancelDelivery':
      return concatBytes(u8(MessageBlockType.cancelDelivery, 5), be32(b.nonce), u8((b.beepType << 4) + b.deliveryType));
    case 'deactivatePod':
      return concatBytes(u8(MessageBlockType.deactivatePod, 4), be32(b.nonce));
    case 'beepConfig':
      return u8(
        MessageBlockType.beepConfig,
        4,
        b.beepType,
        (b.basalCompletionBeep ? 1 << 6 : 0) + (Math.trunc(b.basalIntervalBeep / MINUTE) & 0x3f),
        (b.tempBasalCompletionBeep ? 1 << 6 : 0) + (Math.trunc(b.tempBasalIntervalBeep / MINUTE) & 0x3f),
        (b.bolusCompletionBeep ? 1 << 6 : 0) + (Math.trunc(b.bolusIntervalBeep / MINUTE) & 0x3f),
      );
    case 'statusResponse':
      return encodeStatusResponse(b);
    case 'versionResponse':
      return encodeVersionResponse(b);
    case 'errorResponse':
      return b.error.kind === 'badNonce'
        ? concatBytes(u8(MessageBlockType.errorResponse, 3, 0x14), be16(b.error.nonceResyncKey))
        : u8(MessageBlockType.errorResponse, 3, b.error.code, b.error.faultEventCode.raw, b.error.podProgress);
    case 'podInfoResponse': {
      const info = b.info;
      if (info.podInfoType === PodInfoType.detailedStatus) return concatBytes(u8(MessageBlockType.podInfoResponse, info.raw.length), info.raw);
      if ('raw' in info) return concatBytes(u8(MessageBlockType.podInfoResponse, info.raw.length), info.raw);
      throw new Error('encodeBlock: this pod info type cannot be encoded');
    }
  }
}

function encodeVersionResponse(b: Extract<MessageBlock, { type: 'versionResponse' }>): Bytes {
  const ver = (s: string): Bytes => u8(...s.split('.').map((x) => Number(x)));
  if (b.setup === null) {
    // 0x15 byte "assign address" form (Eros has gain/rssi, DASH has not)
    return concatBytes(u8(MessageBlockType.versionResponse, 0x15), ver(b.firmwareVersion), ver(b.iFirmwareVersion), u8(b.podModel, b.podProgress), be32(b.lot), be32(b.tid), u8(0), be32(b.address));
  }
  const s = b.setup;
  return concatBytes(
    u8(MessageBlockType.versionResponse, 0x1b),
    be16(Math.round(s.pulseSize * 100000)),
    u8(Math.round(s.secondsPerBolusPulse * 8), Math.round(s.secondsPerPrimePulse * 8), Math.round(s.primeUnits * POD.pulsesPerUnit), Math.round(s.cannulaInsertionUnits * POD.pulsesPerUnit), Math.round(s.serviceDuration / 3600)),
    ver(b.firmwareVersion),
    ver(b.iFirmwareVersion),
    u8(b.podModel, b.podProgress),
    be32(b.lot),
    be32(b.tid),
    be32(b.address),
  );
}
