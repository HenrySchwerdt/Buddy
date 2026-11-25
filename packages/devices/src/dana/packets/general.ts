/**
 * TypeScript port of DanaKit/Packets/DanaGeneralGetInitialScreenInformation.swift,
 * DanaGeneralKeepConnection.swift, DanaGeneralGetPumpTime.swift,
 * DanaGeneralGetPumpTimeUtcWithTimezone.swift, DanaGeneralSetPumpTime.swift,
 * DanaGeneralSetPumpTimeUtcWithTimezone.swift and DanaGeneralSetHistoryUploadMode.swift from
 * loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit authors).
 */
import type { Millis } from '@buddy/core';
import { at, DataStart, DanaPacketType, uint16At, type DanaPacket } from '../packet-type';
import { parseStatusByte } from './basal';
import { writeDate } from './dates';

export interface PacketGeneralGetInitialScreenInformation {
  readonly isPumpSuspended: boolean;
  readonly isTempBasalInProgress: boolean;
  readonly isExtendedInProgress: boolean;
  readonly isDualBolusInProgress: boolean;
  readonly dailyTotalUnits: number;
  readonly maxDailyTotalUnits: number;
  readonly reservoirRemainingUnits: number;
  readonly currentBasal: number;
  readonly tempBasalPercent: number;
  readonly batteryRemaining: number;
  readonly extendedBolusAbsoluteRemaining: number;
  readonly insulinOnBoard: number;
  readonly errorState: number | null;
}

export type DanaKitBasal = 'active' | 'suspended' | 'tempBasal';

export const basalDeliveryOrdinal = (s: PacketGeneralGetInitialScreenInformation): DanaKitBasal =>
  s.isPumpSuspended ? 'suspended' : s.isTempBasalInProgress ? 'tempBasal' : 'active';

export const danaGeneralGetInitialScreenInformation = (): DanaPacket<PacketGeneralGetInitialScreenInformation> => ({
  name: 'General_GetInitialScreenInformation',
  opCode: DanaPacketType.OPCODE_REVIEW__INITIAL_SCREEN_INFORMATION,
  generate: () => new Uint8Array(0),
  parse(data) {
    if (data.length < 17) {
      return {
        success: false,
        rawData: data,
        data: {
          isPumpSuspended: false,
          isTempBasalInProgress: false,
          isExtendedInProgress: false,
          isDualBolusInProgress: false,
          dailyTotalUnits: -1,
          maxDailyTotalUnits: -1,
          reservoirRemainingUnits: -1,
          currentBasal: -1,
          tempBasalPercent: -1,
          batteryRemaining: -1,
          extendedBolusAbsoluteRemaining: -1,
          insulinOnBoard: -1,
          errorState: null,
        },
      };
    }

    const statusPump = at(data, DataStart);

    return {
      success: true,
      rawData: data,
      data: {
        isPumpSuspended: (statusPump & 0x01) === 0x01,
        isTempBasalInProgress: (statusPump & 0x10) === 0x10,
        isExtendedInProgress: (statusPump & 0x04) === 0x04,
        isDualBolusInProgress: (statusPump & 0x08) === 0x08,
        dailyTotalUnits: uint16At(data, DataStart + 1) / 100,
        maxDailyTotalUnits: uint16At(data, DataStart + 3) / 100,
        reservoirRemainingUnits: uint16At(data, DataStart + 5) / 100,
        currentBasal: uint16At(data, DataStart + 7) / 100,
        tempBasalPercent: at(data, DataStart + 9),
        batteryRemaining: at(data, DataStart + 10),
        extendedBolusAbsoluteRemaining: uint16At(data, DataStart + 11) / 100,
        insulinOnBoard: uint16At(data, DataStart + 13) / 100,
        errorState: data.length > 17 ? at(data, DataStart + 15) : null,
      },
    };
  },
});

export const danaGeneralKeepConnection = (): DanaPacket<null> => ({
  name: 'General_KeepConnection',
  opCode: DanaPacketType.OPCODE_ETC__KEEP_CONNECTION,
  generate: () => new Uint8Array(0),
  parse: parseStatusByte,
});

export interface PacketGeneralGetPumpTime {
  readonly time: Millis;
}

export const danaGeneralGetPumpTime = (): DanaPacket<PacketGeneralGetPumpTime> => ({
  name: 'General_GetPumpTime',
  opCode: DanaPacketType.OPCODE_OPTION__GET_PUMP_TIME,
  generate: () => new Uint8Array(0),
  parse(data) {
    if (data.length < DataStart + 6) return { success: false, rawData: data, data: null };
    // Calendar.current.date(from: components) — local time zone
    const time = new Date(
      2000 + at(data, DataStart),
      at(data, DataStart + 1) - 1,
      at(data, DataStart + 2),
      at(data, DataStart + 3),
      at(data, DataStart + 4),
      at(data, DataStart + 5),
    ).getTime();
    if (!Number.isFinite(time)) return { success: false, rawData: data, data: null };
    return { success: true, rawData: data, data: { time } };
  },
});

export interface PacketGeneralGetPumpTimeUtcWithTimezone {
  readonly time: Millis;
  readonly timezoneOffset: number;
}

export const danaGeneralGetPumpTimeUtcWithTimezone = (): DanaPacket<PacketGeneralGetPumpTimeUtcWithTimezone> => ({
  name: 'General_GetPumpTimeUtcWithTimezone',
  opCode: DanaPacketType.OPCODE_OPTION__GET_PUMP_UTC_AND_TIME_ZONE,
  generate: () => new Uint8Array(0),
  parse(data) {
    if (data.length < DataStart + 7) return { success: false, rawData: data, data: null };
    // Int8(bitPattern:)
    const timezoneOffsetInHours = (at(data, DataStart + 6) << 24) >> 24;

    // As in DanaKit: UTC components + offset hours, interpreted by Calendar.current (local zone)
    const time = new Date(
      2000 + at(data, DataStart),
      at(data, DataStart + 1) - 1,
      at(data, DataStart + 2),
      at(data, DataStart + 3) + timezoneOffsetInHours,
      at(data, DataStart + 4),
      at(data, DataStart + 5),
    ).getTime();
    if (!Number.isFinite(time)) return { success: false, rawData: data, data: null };

    return { success: true, rawData: data, data: { time, timezoneOffset: timezoneOffsetInHours } };
  },
});

export const danaGeneralSetPumpTime = (options: { readonly time: Millis }): DanaPacket<null> => ({
  name: 'General_SetPumpTime',
  opCode: DanaPacketType.OPCODE_OPTION__SET_PUMP_TIME,
  generate() {
    const data = new Uint8Array(6);
    writeDate(data, 0, options.time, false);
    return data;
  },
  parse: parseStatusByte,
});

export const danaGeneralSetPumpTimeUtcWithTimezone = (options: { readonly time: Millis; readonly zoneOffset: number }): DanaPacket<null> => ({
  name: 'General_SetPumpTimeUtcWithTimezone',
  opCode: DanaPacketType.OPCODE_OPTION__SET_PUMP_UTC_AND_TIME_ZONE,
  generate() {
    const data = new Uint8Array(7);
    writeDate(data, 0, options.time);
    data[6] = options.zoneOffset & 0xff;
    return data;
  },
  parse: parseStatusByte,
});

export const danaGeneralSetHistoryUploadMode = (options: {
  /**
   * 1 -> Turn on history upload mode, 0 -> turn off history upload mode.
   *
   * Need to do this before and after fetching the history from pump
   */
  readonly mode: 0 | 1;
}): DanaPacket<null> => ({
  name: 'General_SetHistoryUploadMode',
  opCode: DanaPacketType.OPCODE_REVIEW__SET_HISTORY_UPLOAD_MODE,
  generate: () => new Uint8Array([options.mode]),
  parse: parseStatusByte,
});
