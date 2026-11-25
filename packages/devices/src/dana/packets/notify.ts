/**
 * TypeScript port of DanaKit/Packets/DanaNotifyDeliveryComplete.swift,
 * DanaNotifyDeliveryRateDisplay.swift, DanaNotifyAlarm.swift and DanaNotifyMissedBolus.swift
 * from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit authors).
 * Alarm names follow DanaKit/PumpManager/PumpManagerAlert.swift.
 */
import type { Bytes } from '@buddy/core';
import { at, DataStart, DanaPacketType, uint16At, type DanaParsed } from '../packet-type';

const notifyType = (opCode: number): number => ((DanaPacketType.TYPE_NOTIFY & 0xff) << 8) + opCode;

export interface PacketNotifyDelivery {
  readonly deliveredInsulin: number;
}

export function parseNotifyDeliveryComplete(data: Bytes): DanaParsed<PacketNotifyDelivery> {
  return {
    success: data.length >= DataStart + 2,
    notifyType: notifyType(DanaPacketType.OPCODE_NOTIFY__DELIVERY_COMPLETE),
    rawData: data,
    data: { deliveredInsulin: uint16At(data, DataStart) / 100 },
  };
}

export function parseNotifyDeliveryRateDisplay(data: Bytes): DanaParsed<PacketNotifyDelivery> {
  return {
    success: data.length >= DataStart + 2,
    notifyType: notifyType(DanaPacketType.OPCODE_NOTIFY__DELIVERY_RATE_DISPLAY),
    rawData: data,
    data: { deliveredInsulin: uint16At(data, DataStart) / 100 },
  };
}

const DANA_NOTIFY_ALARM: Readonly<Record<number, string>> = {
  0x01: 'batteryZeroPercent',
  0x02: 'pumpError',
  0x03: 'occlusion',
  0x04: 'lowBattery',
  0x05: 'shutdown',
  0x06: 'basalCompare',
  0x07: 'bloodSugarMeasure',
  0xff: 'bloodSugarMeasure',
  0x08: 'remainingInsulinLevel',
  0xfe: 'remainingInsulinLevel',
  0x09: 'emptyReservoir',
  0x0a: 'checkShaft',
  0x0b: 'basalMax',
  0x0c: 'dailyMax',
  0xfd: 'bloodSugarCheckMiss',
};

export interface PacketNotifyAlarm {
  readonly code: number;
  readonly alert: string;
}

export function parseNotifyAlarm(data: Bytes): DanaParsed<PacketNotifyAlarm> {
  const code = at(data, DataStart);
  return {
    success: true,
    notifyType: notifyType(DanaPacketType.OPCODE_NOTIFY__ALARM),
    rawData: data,
    data: { code, alert: DANA_NOTIFY_ALARM[code] ?? 'unknown' },
  };
}

export interface PacketNotifyMissedBolus {
  /** Seconds after midnight, as encoded by DanaKit (`(hour * 3600 + min * 60) * 60` — sic). */
  readonly startTime: number;
  readonly endTime: number;
}

export function parseNotifyMissedBolus(data: Bytes): DanaParsed<PacketNotifyMissedBolus> {
  return {
    success: at(data, DataStart) !== 0x01 && at(data, DataStart + 1) !== 0x01 && at(data, DataStart + 2) !== 0x01 && at(data, DataStart + 3) !== 0x01,
    notifyType: notifyType(DanaPacketType.OPCODE_NOTIFY__MISSED_BOLUS_ALARM),
    rawData: data,
    data: {
      startTime: (at(data, DataStart) * 3600 + at(data, DataStart + 1) * 60) * 60,
      endTime: (at(data, DataStart + 2) * 3600 + at(data, DataStart + 3) * 60) * 60,
    },
  };
}
