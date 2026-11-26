/**
 * Message bodies of the Medtronic RF protocol: TypeScript port of the `*MessageBody.swift` files of
 * MinimedKit (migrated from ps2/rileylink_ios, MIT License, (c) LoopKit Authors) that the driver
 * needs. Not ported: MySentry, remote control IDs, meter and glucose page messages, button
 * presses, "other devices" and the max bolus / max basal setters (the driver never changes pump
 * limits or presses buttons).
 *
 * `decodeBody` is the receive side (`MessageType.decodeType`), the `*Body` functions build what is
 * sent. Long bodies are 65 bytes, a "short" body is the single byte 0 that opens a command.
 */
import { u16be, type Bytes } from '@buddy/core';
import { MessageType } from './message-type';

export const LONG_BODY_LENGTH = 65;

/** Pads with zeros to `length` (Swift `Data.paddedTo`). */
export function padTo(data: Bytes, length: number): Bytes {
  const out = new Uint8Array(Math.max(length, data.length));
  out.set(data);
  return out;
}

const ascii = (b: Bytes): string => String.fromCharCode(...b);

/** `PumpErrorCode`: what the pump says when it rejects a command. */
export const PumpErrorCode = { commandRefused: 0x08, maxSettingExceeded: 0x09, bolusInProgress: 0x0c, pageDoesNotExist: 0x0d } as const;
export type PumpErrorCodeValue = (typeof PumpErrorCode)[keyof typeof PumpErrorCode];

export function describePumpError(code: number): string {
  switch (code) {
    case PumpErrorCode.commandRefused:
      return 'Command refused (check that the pump is not suspended or priming, and that its temp basal type is units per hour)';
    case PumpErrorCode.maxSettingExceeded:
      return 'Max setting exceeded';
    case PumpErrorCode.bolusInProgress:
      return 'Bolus in progress';
    case PumpErrorCode.pageDoesNotExist:
      return 'History page does not exist';
    default:
      return `Unknown pump error code ${code}`;
  }
}

export type BatteryStatus = 'low' | 'normal' | { readonly unknown: number };
export type BasalProfileKind = 'standard' | 'profileA' | 'profileB';
export type TempBasalRateType = 'absolute' | 'percent';

/** Wall-clock time as the pump keeps it (no time zone). */
export interface PumpClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export type MessageBody =
  | { readonly kind: 'ack'; readonly txData: Bytes }
  | { readonly kind: 'error'; readonly code: number; readonly txData: Bytes }
  | { readonly kind: 'pumpModel'; readonly model: string; readonly txData: Bytes }
  | { readonly kind: 'firmware'; readonly version: string; readonly txData: Bytes }
  | { readonly kind: 'battery'; readonly status: BatteryStatus; readonly volts: number; readonly txData: Bytes }
  | { readonly kind: 'pumpStatus'; readonly bolusing: boolean; readonly suspended: boolean; readonly txData: Bytes }
  | { readonly kind: 'remainingInsulin'; readonly raw: Bytes; readonly txData: Bytes }
  | { readonly kind: 'settings'; readonly maxBasal: number; readonly maxBolus: number; readonly insulinActionCurveHours: number; readonly selectedBasalProfile: BasalProfileKind; readonly txData: Bytes }
  | { readonly kind: 'time'; readonly clock: PumpClock; readonly txData: Bytes }
  | { readonly kind: 'tempBasal'; readonly rateType: TempBasalRateType; readonly rate: number; readonly timeRemainingMin: number; readonly txData: Bytes }
  | { readonly kind: 'dataFrame'; readonly isLastFrame: boolean; readonly frameNumber: number; readonly contents: Bytes; readonly txData: Bytes }
  | { readonly kind: 'historyPage'; readonly lastFrame: boolean; readonly frameNumber: number; readonly frame: Bytes; readonly txData: Bytes }
  /** Anything a command sends: only the bytes matter. */
  | { readonly kind: 'raw'; readonly txData: Bytes };

export type BodyOfKind<K extends MessageBody['kind']> = Extract<MessageBody, { kind: K }>;

/** Strokes -> units of a ReadRemainingInsulin body (`getUnitsRemaining`). */
export function unitsRemaining(raw: Bytes, insulinBitPackingScale: number): number {
  const strokes = insulinBitPackingScale > 10 ? u16be(raw, 3) : u16be(raw, 1);
  return strokes / insulinBitPackingScale;
}

const basalProfileOf = (b: number): BasalProfileKind => (b === 1 ? 'profileA' : b === 2 ? 'profileB' : 'standard');

/** Parses the body that follows the 5 byte header; null when it does not have the layout of its message type. */
export function decodeBody(messageType: number, rx: Bytes): MessageBody | null {
  const long = rx.length === LONG_BODY_LENGTH;
  switch (messageType) {
    case MessageType.pumpAck:
      return { kind: 'ack', txData: rx };
    case MessageType.errorResponse:
      return rx.length >= 1 ? { kind: 'error', code: rx[0]!, txData: rx } : null;
    case MessageType.getPumpModel:
      return long ? { kind: 'pumpModel', model: ascii(rx.subarray(2, 5)), txData: rx } : null;
    case MessageType.readFirmwareVersion: {
      if (!long) return null;
      const zero = rx.indexOf(0);
      const end = zero < 0 ? rx.length : zero;
      return end >= 1 ? { kind: 'firmware', version: ascii(rx.subarray(1, end)), txData: rx } : null;
    }
    case MessageType.getBattery:
      return long ? { kind: 'battery', status: rx[1] === 1 ? 'low' : rx[1] === 0 ? 'normal' : { unknown: rx[1]! }, volts: ((rx[2]! << 8) + rx[3]!) / 100, txData: rx } : null;
    case MessageType.readPumpStatus:
      return long ? { kind: 'pumpStatus', bolusing: rx[2]! > 0, suspended: rx[3]! > 0, txData: rx } : null;
    case MessageType.readRemainingInsulin:
      return long ? { kind: 'remainingInsulin', raw: rx, txData: rx } : null;
    case MessageType.readSettings: {
      if (!long) return null;
      const newer = rx[0] === 25; // x23 layout
      const maxBolusTicks = newer ? rx[7]! : rx[6]!;
      const maxBasalTicks = newer ? u16be(rx, 8) : u16be(rx, 7);
      return {
        kind: 'settings',
        maxBolus: maxBolusTicks / 10,
        maxBasal: maxBasalTicks / 40,
        selectedBasalProfile: basalProfileOf(rx[12]!),
        insulinActionCurveHours: rx[18]!,
        txData: rx,
      };
    }
    case MessageType.readTime:
      return long ? { kind: 'time', clock: { hour: rx[1]!, minute: rx[2]!, second: rx[3]!, year: u16be(rx, 4), month: rx[6]!, day: rx[7]! }, txData: rx } : null;
    case MessageType.readTempBasal: {
      if (!long) return null;
      const timeRemainingMin = u16be(rx, 5);
      if (rx[1] === 0) return { kind: 'tempBasal', rateType: 'absolute', rate: u16be(rx, 3) / 40, timeRemainingMin, txData: rx };
      if (rx[1] === 1) return { kind: 'tempBasal', rateType: 'percent', rate: rx[2]!, timeRemainingMin, txData: rx };
      return null;
    }
    case MessageType.readProfileStd512:
    case MessageType.readProfileA512:
    case MessageType.readProfileB512:
      return long ? { kind: 'dataFrame', isLastFrame: (rx[0]! & 0x80) !== 0, frameNumber: rx[0]! & 0x7f, contents: rx.slice(1), txData: rx } : null;
    case MessageType.getHistoryPage:
      return long ? { kind: 'historyPage', lastFrame: (rx[0]! & 0x80) !== 0, frameNumber: rx[0]! & 0x7f, frame: rx.slice(1, 65), txData: rx } : null;
    default:
      return { kind: 'raw', txData: rx };
  }
}

// ── bodies that are sent ─────────────────────────────────────────────────────

export const raw = (txData: Bytes): MessageBody => ({ kind: 'raw', txData });

/** The single zero byte that opens every command. */
export const shortBody = (): MessageBody => raw(Uint8Array.of(0));

/** `PowerOnCarelinkMessageBody`: keep the pump's radio on for `durationMs` (rounded up to whole minutes). */
export const powerOnBody = (durationMs: number): MessageBody => raw(padTo(Uint8Array.of(2, 1, Math.ceil(durationMs / 60_000)), LONG_BODY_LENGTH));

/**
 * `BolusCarelinkMessageBody`: x23+ pumps (scale 40) take 2 byte strokes and scroll faster for
 * larger amounts (steps of 0.05 U above 1 U, 0.1 U above 10 U); older pumps take 1 byte (0.1 U).
 */
export function bolusBody(units: number, insulinBitPackingScale = 10): MessageBody {
  let length: number;
  let scrollRate: number;
  if (insulinBitPackingScale >= 40) {
    length = 2;
    scrollRate = units > 10 ? 4 : units > 1 ? 2 : 1;
  } else {
    length = 1;
    scrollRate = 1;
  }
  // DEVIATION: 1e-9 keeps 0.35 * 40 = 13.999999999999998 from losing a stroke
  const strokes = Math.trunc(units * Math.trunc(insulinBitPackingScale / scrollRate) + 1e-9) * scrollRate;
  const data = length === 2 ? Uint8Array.of(length, (strokes >> 8) & 0xff, strokes & 0xff) : Uint8Array.of(length, strokes & 0xff);
  return raw(padTo(data, LONG_BODY_LENGTH));
}

/** `ChangeTempBasalCarelinkMessageBody`: absolute rate in 1/40 U, duration in 30 minute segments (0 and 0 cancels). */
export function changeTempBasalBody(unitsPerHour: number, durationMs: number): MessageBody {
  const strokes = Math.trunc(unitsPerHour * 40 + 1e-9);
  const segments = Math.trunc(durationMs / (30 * 60_000));
  return raw(padTo(Uint8Array.of(3, (strokes >> 8) & 0xff, strokes & 0xff, segments & 0xff), LONG_BODY_LENGTH));
}

export type SuspendResumeState = 'suspend' | 'resume';
export const suspendResumeBody = (state: SuspendResumeState): MessageBody => raw(padTo(Uint8Array.of(1, state === 'suspend' ? 1 : 0), LONG_BODY_LENGTH));

/** `ChangeTimeCarelinkMessageBody`; null for an impossible date. */
export function changeTimeBody(c: PumpClock): MessageBody | null {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second));
  const valid = d.getUTCFullYear() === c.year && d.getUTCMonth() === c.month - 1 && d.getUTCDate() === c.day && c.hour < 24 && c.minute < 60 && c.second < 60;
  if (!valid) return null;
  return raw(padTo(Uint8Array.of(7, c.hour, c.minute, c.second, (c.year >> 8) & 0xff, c.year & 0xff, c.month, c.day), LONG_BODY_LENGTH));
}

export const getHistoryPageBody = (pageNum: number): MessageBody => raw(padTo(Uint8Array.of(1, pageNum & 0xff), LONG_BODY_LENGTH));
