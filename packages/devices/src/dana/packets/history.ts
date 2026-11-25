/**
 * TypeScript port of DanaKit/Packets/DanaHistoryBase.swift, DanaHistoryAll.swift and
 * DanaHistoryBolus.swift from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit
 * authors).
 */
import type { Bytes, Millis } from '@buddy/core';
import { at, DataStart, DanaPacketType, type DanaPacket, type DanaParsed } from '../packet-type';
import { readDate, writeDate } from './dates';

export const HistoryCode = {
  RECORD_TYPE_DONE_UPLOAD: -0x01,
  RECORD_TYPE_UNKNOWN: 0x00,
  RECORD_TYPE_BOLUS: 0x02,
  RECORD_TYPE_DAILY: 0x03,
  RECORD_TYPE_PRIME: 0x04,
  RECORD_TYPE_REFILL: 0x05,
  RECORD_TYPE_GLUCOSE: 0x06,
  RECORD_TYPE_CARBO: 0x07,
  RECORD_TYPE_SUSPEND: 0x09,
  RECORD_TYPE_ALARM: 0x0a,
  RECORD_TYPE_BASALHOUR: 0x0b,
  RECORD_TYPE_TEMP_BASAL: 0x99,
} as const;

export interface PacketHistoryBase {
  /** `nil` requests everything (encoded as 2000-01-01 00:00:00). */
  readonly from: Millis | null;
  readonly usingUtc: boolean;
}

export interface HistoryItem {
  readonly code: number;
  readonly raw: Bytes;
  readonly timestamp: Millis;
  readonly value?: number;
  readonly durationInMin?: number;
  readonly dailyBasal?: number;
  readonly dailyBolus?: number;
  readonly alarm?: number;
  readonly bolusType?: string;
}

export function generatePacketHistoryData(options: PacketHistoryBase): Bytes {
  const data = new Uint8Array(6);

  if (options.from === null) {
    data.set([0, 1, 1, 0, 0, 0]);
  } else {
    writeDate(data, 0, options.from, options.usingUtc);
  }

  return data;
}

export function getBolusType(param8: number): string {
  switch (param8 & 0xf0) {
    case 0xa0:
      return 'DS';
    case 0xc0:
      return 'E';
    case 0x80:
      return 'S';
    case 0x90:
      return 'DE';
    default:
      return 'None';
  }
}

export function getAlarmMessage(param8: number | undefined): string {
  switch (param8) {
    case undefined:
      return '';
    case 0x50:
      return 'Basal Compare';
    case 0x52:
      return 'Empty Reservoir';
    case 0x43:
      return 'Check';
    case 0x4f:
      return 'Occlusion';
    case 0x4d:
      return 'Basal max';
    case 0x44:
      return 'Daily max';
    case 0x42:
      return 'Low Battery';
    case 0x53:
      return 'Shutdown';
    default:
      return 'None';
  }
}

/** Minimum length of a record message (Swift reads up to `DataStart + 9` without checking). */
const RECORD_LENGTH = DataStart + 10;

export function parseHistory(data: Bytes, usingUtcOpt: boolean | null, now: () => Millis = Date.now): DanaParsed<HistoryItem> {
  const usingUtc = usingUtcOpt ?? true;
  if (data.length === 3) {
    return { success: false, rawData: data, data: { code: HistoryCode.RECORD_TYPE_UNKNOWN, raw: data, timestamp: now(), value: at(data, DataStart) } };
  }

  // This packet marks the upload of history to be done
  if (data.length === 5) {
    return {
      success: at(data, DataStart) === 0x00,
      rawData: data,
      data: { code: HistoryCode.RECORD_TYPE_DONE_UPLOAD, raw: data, timestamp: now(), value: at(data, DataStart) },
    };
  }

  if (data.length < RECORD_LENGTH) {
    return { success: false, rawData: data, data: { code: HistoryCode.RECORD_TYPE_UNKNOWN, raw: data, timestamp: now() } };
  }

  const param7 = at(data, DataStart + 6);
  const param8 = at(data, DataStart + 7);
  const value = (at(data, DataStart + 8) << 8) + at(data, DataStart + 9);
  const timestamp = readDate(data, DataStart + 1, usingUtc);
  const ok = (item: HistoryItem): DanaParsed<HistoryItem> => ({ success: true, rawData: data, data: item });

  const recordType = at(data, DataStart);
  switch (recordType) {
    case HistoryCode.RECORD_TYPE_BOLUS:
      return ok({
        code: HistoryCode.RECORD_TYPE_BOLUS,
        raw: data,
        timestamp,
        value: value * 0.01,
        // Swift computes this in UInt8 and would trap for (param8 & 0x0F) >= 5; full integer math here
        durationInMin: (param8 & 0x0f) * 60 + param7,
        bolusType: getBolusType(param8),
      });

    case HistoryCode.RECORD_TYPE_DAILY: {
      const dailyBasal = ((at(data, DataStart + 4) << 8) + at(data, DataStart + 5)) * 0.01;
      const dailyBolus = ((at(data, DataStart + 6) << 8) + at(data, DataStart + 7)) * 0.01;
      // Calendar.current.date(bySettingHour: 0, minute: 0, second: 0, of: timestamp)
      const midnight = new Date(timestamp);
      midnight.setHours(0, 0, 0, 0);
      return ok({ code: HistoryCode.RECORD_TYPE_DAILY, raw: data, timestamp: midnight.getTime(), dailyBasal, dailyBolus });
    }

    case HistoryCode.RECORD_TYPE_PRIME:
    case HistoryCode.RECORD_TYPE_REFILL:
    case HistoryCode.RECORD_TYPE_BASALHOUR:
    case HistoryCode.RECORD_TYPE_TEMP_BASAL:
      return ok({ code: recordType, raw: data, timestamp, value: value * 0.01 });

    case HistoryCode.RECORD_TYPE_GLUCOSE:
    case HistoryCode.RECORD_TYPE_CARBO:
      return ok({ code: recordType, raw: data, timestamp, value });

    case HistoryCode.RECORD_TYPE_SUSPEND:
      return ok({ code: HistoryCode.RECORD_TYPE_SUSPEND, raw: data, timestamp, value: param8 === 0x4f ? 1 : 0 });

    case HistoryCode.RECORD_TYPE_ALARM:
      return ok({
        code: HistoryCode.RECORD_TYPE_ALARM,
        raw: data,
        timestamp,
        value: value * 0.01,
        alarm: param8, // getAlarmMessage(param8: param8)
      });

    default:
      return {
        success: false,
        rawData: data,
        // "UNKNOWN Message type: \(recordType)"
        data: { code: HistoryCode.RECORD_TYPE_UNKNOWN, raw: data, timestamp, alarm: recordType },
      };
  }
}

const historyPacket = (name: string, opCode: number, options: PacketHistoryBase): DanaPacket<HistoryItem> => ({
  name,
  opCode,
  isHistory: true,
  generate: () => generatePacketHistoryData(options),
  parse: (data, usingUtc) => parseHistory(data, usingUtc),
});

export const danaHistoryAll = (options: PacketHistoryBase): DanaPacket<HistoryItem> =>
  historyPacket('Review_AllHistory', DanaPacketType.OPCODE_REVIEW__ALL_HISTORY, options);

export const danaHistoryBolus = (options: PacketHistoryBase): DanaPacket<HistoryItem> =>
  historyPacket('Review_Bolus', DanaPacketType.OPCODE_REVIEW__BOLUS, options);
