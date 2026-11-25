/**
 * TypeScript port of the command packets in `MedtrumKit/Packets/` from loopandlearn/MedtrumKit
 * (MIT License, (c) the original MedtrumKit authors): AuthorizePacket, SubscribePacket,
 * GetTimePacket, SetTimePacket, SetTimeZonePacket, PrimePacket, ActivatePacket, SetPatchPacket,
 * SetBolusPacket, CancelBolusPacket, SetBasalProfilePacket, SetTempBasalPacket,
 * CancelTempBasalPacket, SuspendPumpPacket, ResumePumpPacket, StopPatchPacket, ClearAlertPacket.
 *
 * Response offsets index `totalData`, which starts with the 4-byte header and the 2-byte
 * response code, so the first payload byte is at index 6.
 */
import type { Bytes, Millis } from '@buddy/core';
import { concatBytes } from '@buddy/core';
import { MedtrumBasePacket } from './base-packet';
import { byteAt, fromMedtrumSeconds, insulinToSteps, leUint, stepsToInsulin, toLeBytes, toMedtrumSeconds } from './bytes';
import { genKey } from './crypto';
import { CommandType, parseBasalType, type AlarmSettings, type BasalType, type ClearAlarmType } from './enums';

const empty = (): Bytes => new Uint8Array(0);

/** Insulin value as 2 bytes LE of 0.05 U steps (floored, see `insulinToSteps`). */
function insulinU16(amount: number, what: string): Bytes {
  const steps = insulinToSteps(amount);
  if (steps > 0xffff) throw new RangeError(`Medtrum: ${what} ${amount} does not fit the packet`);
  return toLeBytes(steps, 2);
}

/** Basal state echoed by SetTempBasal / CancelTempBasal / SetBasalProfile. */
export interface BasalResponse {
  readonly basalType: BasalType;
  /** U/h */
  readonly basalValue: number;
  readonly basalSequence: number;
  readonly basalPatchId: number;
  readonly basalStartTime: Millis;
}

const parseBasalResponse = (d: Bytes): BasalResponse => ({
  basalType: parseBasalType(byteAt(d, 6)),
  basalValue: stepsToInsulin(leUint(d, 7, 2)),
  basalSequence: leUint(d, 9, 2),
  basalPatchId: leUint(d, 11, 2),
  basalStartTime: fromMedtrumSeconds(leUint(d, 13, 4)),
});

// ── Connection ───────────────────────────────────────────────────────────────

export interface AuthorizeResponse {
  readonly deviceType: number;
  readonly swVersion: string;
}

export class AuthorizePacket extends MedtrumBasePacket<AuthorizeResponse> {
  readonly commandType = CommandType.AUTH_REQ;
  readonly minimumDataSize = 10;

  private readonly role = 2;
  private readonly pumpSN: Bytes;

  /** `pumpSN` as stored (big-endian serial bytes, e.g. fromHex("AA76F9D9")); reversed here like the Swift original. */
  constructor(pumpSN: Bytes, private readonly sessionToken: Bytes) {
    super();
    this.pumpSN = pumpSN.slice().reverse();
  }

  getRequestBytes(): Bytes {
    const key = genKey(this.pumpSN);
    return concatBytes(new Uint8Array([this.role]), this.sessionToken, key);
  }

  parseResponse(): AuthorizeResponse {
    const d = this.totalData;
    return { deviceType: byteAt(d, 7), swVersion: `${byteAt(d, 8)}.${byteAt(d, 9)}.${byteAt(d, 10)}` };
  }
}

export class SubscribePacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.SUBSCRIBE;
  readonly minimumDataSize = 0;
  getRequestBytes(): Bytes {
    return toLeBytes(4095, 2);
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

// ── Time ─────────────────────────────────────────────────────────────────────

export class GetTimePacket extends MedtrumBasePacket<{ readonly time: Millis }> {
  readonly commandType = CommandType.GET_TIME;
  readonly minimumDataSize = 10;
  getRequestBytes(): Bytes {
    return empty();
  }
  parseResponse(): { readonly time: Millis } {
    return { time: fromMedtrumSeconds(leUint(this.totalData, 6, 4)) };
  }
}

export class SetTimePacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.SET_TIME;
  readonly minimumDataSize = 0;
  constructor(private readonly date: Millis) {
    super();
  }
  getRequestBytes(): Bytes {
    return concatBytes(new Uint8Array([2]), toMedtrumSeconds(this.date));
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

const HOUR_S = 3600;

export class SetTimeZonePacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.SET_TIME_ZONE;
  readonly minimumDataSize = 0;
  /** `utcOffsetSeconds`: `TimeZone.secondsFromGMT(for: date)` of the phone's time zone at `date`. */
  constructor(private readonly date: Millis, private readonly utcOffsetSeconds: number) {
    super();
  }
  getRequestBytes(): Bytes {
    let offset = this.utcOffsetSeconds;
    // Workaround for bug where it fails to set timezone > GMT + 12
    // if offset is > 12 hours, subtract 24 hours
    if (offset > 12 * HOUR_S) offset -= 24 * HOUR_S;

    let offsetInMinutes = Math.trunc(offset / 60);
    if (offsetInMinutes < 0) offsetInMinutes += 65536;

    return concatBytes(new Uint8Array([offsetInMinutes & 0xff, (offsetInMinutes >> 8) & 0xff]), toMedtrumSeconds(this.date));
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

// ── Activation ───────────────────────────────────────────────────────────────

export class PrimePacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.PRIME;
  readonly minimumDataSize = 0;
  getRequestBytes(): Bytes {
    return empty();
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

export interface ActivatePacketResponse {
  /** 4 raw bytes as sent by the patch */
  readonly patchId: Bytes;
  readonly time: Millis;
  readonly basalType: BasalType;
  readonly basalValue: number;
  readonly basalSequence: number;
  readonly basalPatchId: number;
  readonly basalStartTime: Millis;
}

export interface ActivateOptions {
  /** 0 = no expiration, 1 = 12 hour reminder and expiration after 3 days */
  readonly expirationTimer: number;
  readonly alarmSetting: AlarmSettings;
  readonly hourlyMaxInsulin: number;
  readonly dailyMaxInsulin: number;
  readonly currentTDD: number;
  /** Output of `basalScheduleToBytes` */
  readonly basalProfile: Bytes;
}

export class ActivatePacket extends MedtrumBasePacket<ActivatePacketResponse> {
  readonly commandType = CommandType.ACTIVATE;
  readonly minimumDataSize = 25;

  readonly autoSuspendEnable = 0;
  readonly autoSuspendTime = 12; // unknown why this value needs to be this
  readonly lowSuspend = 0;
  readonly predictiveLowSuspend = 0;
  readonly predictiveLowSuspendRange = 30; // Not sure why, but pump needs this in order to activate

  constructor(private readonly o: ActivateOptions) {
    super();
  }

  /**
   * byte 1: autoSuspendEnable -> Value for auto mode, not used for LoopKit
   * byte 2: autoSuspendTime -> Value for auto mode, not used for LoopKit
   * byte 3: expirationTimer -> Expiration timer, 0 = no expiration 1 = 12 hour reminder and expiration after 3 days
   * byte 4: alarmSetting -> see AlarmSetting
   * byte 5: lowSuspend -> Value for auto mode, not used for LoopKit
   * byte 6: predictiveLowSuspend -> Value for auto mode, not used for LoopKit
   * byte 7: predictiveLowSuspendRange -> Value for auto mode, not used for LoopKit
   * byte 8-9: hourlyMaxInsulin -> Max hourly dose of insulin, divided by 0.05
   * byte 10-11: dailyMaxSet -> Max daily dose of insulin, divided by 0.05
   * byte 12-13: tddToday -> Current TDD (of present day), divided by 0.05
   * byte 14: 1 -> Always 1
   * bytes 15 - end -> Basal profile
   */
  getRequestBytes(): Bytes {
    const o = this.o;
    return concatBytes(
      new Uint8Array([
        this.autoSuspendEnable,
        this.autoSuspendTime,
        o.expirationTimer,
        o.alarmSetting,
        this.lowSuspend,
        this.predictiveLowSuspend,
        this.predictiveLowSuspendRange,
      ]),
      insulinU16(o.hourlyMaxInsulin, 'hourly max'),
      insulinU16(o.dailyMaxInsulin, 'daily max'),
      insulinU16(o.currentTDD, 'TDD'),
      new Uint8Array([1]),
      o.basalProfile,
    );
  }

  parseResponse(): ActivatePacketResponse {
    const d = this.totalData;
    if (d.length < 25) throw new RangeError('Medtrum: activate response too short');
    return {
      patchId: d.slice(6, 10),
      time: fromMedtrumSeconds(leUint(d, 10, 4)),
      basalType: parseBasalType(byteAt(d, 14)),
      basalValue: stepsToInsulin(leUint(d, 15, 2)),
      basalSequence: leUint(d, 17, 2),
      basalPatchId: leUint(d, 19, 2),
      basalStartTime: fromMedtrumSeconds(leUint(d, 21, 4)),
    };
  }
}

export interface SetPatchOptions {
  readonly alarmSettings: AlarmSettings;
  readonly hourlyMaxInsulin: number;
  readonly dailyMaxInsulin: number;
  readonly expirationTimer: number;
}

export class SetPatchPacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.SET_PATCH;
  readonly minimumDataSize = 0;
  readonly autoSuspendEnable = 0;
  readonly autoSuspendTime = 12;
  readonly lowSuspend = 0;
  readonly predictiveLowSuspend = 0;
  readonly predictiveLowSuspendRange = 30;

  constructor(private readonly o: SetPatchOptions) {
    super();
  }

  getRequestBytes(): Bytes {
    return concatBytes(
      new Uint8Array([this.o.alarmSettings]),
      insulinU16(this.o.hourlyMaxInsulin, 'hourly max'),
      insulinU16(this.o.dailyMaxInsulin, 'daily max'),
      new Uint8Array([
        this.o.expirationTimer,
        this.autoSuspendEnable,
        this.autoSuspendTime,
        this.lowSuspend,
        this.predictiveLowSuspend,
        this.predictiveLowSuspendRange,
      ]),
    );
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

export interface StopPatchResponse {
  readonly sequence: number;
  readonly patchId: number;
}

export class StopPatchPacket extends MedtrumBasePacket<StopPatchResponse> {
  readonly commandType = CommandType.STOP_PATCH;
  readonly minimumDataSize = 10;
  getRequestBytes(): Bytes {
    return empty();
  }
  parseResponse(): StopPatchResponse {
    return { sequence: leUint(this.totalData, 6, 2), patchId: leUint(this.totalData, 8, 2) };
  }
}

// ── Bolus ────────────────────────────────────────────────────────────────────

export class SetBolusPacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.SET_BOLUS;
  readonly minimumDataSize = 0;
  // Bolus types: 1 = normal, 2 = Extended, 3 = Combi
  readonly bolusType = 1;

  constructor(readonly bolusAmount: number) {
    super();
  }

  getRequestBytes(): Bytes {
    return concatBytes(new Uint8Array([this.bolusType]), insulinU16(this.bolusAmount, 'bolus'), new Uint8Array([0]));
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

export class CancelBolusPacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.CANCEL_BOLUS;
  readonly minimumDataSize = 0;
  /**
   * 1 -> Normal bolus
   * 2 -> Extended bolus
   * 3 -> Combi bolus
   */
  private readonly bolusType = 1;
  getRequestBytes(): Bytes {
    return new Uint8Array([this.bolusType]);
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

// ── Basal ────────────────────────────────────────────────────────────────────

export class SetBasalProfilePacket extends MedtrumBasePacket<BasalResponse> {
  readonly commandType = CommandType.SET_BASAL_PROFILE;
  readonly minimumDataSize = 17;
  readonly basalType = 1; // Fixed to normal basal profile
  constructor(private readonly basalProfile: Bytes) {
    super();
  }
  getRequestBytes(): Bytes {
    return concatBytes(new Uint8Array([this.basalType]), this.basalProfile);
  }
  parseResponse(): BasalResponse {
    return parseBasalResponse(this.totalData);
  }
}

export class SetTempBasalPacket extends MedtrumBasePacket<BasalResponse> {
  readonly commandType = CommandType.SET_TEMP_BASAL;
  readonly minimumDataSize = 17;
  readonly type = 6; // Fixed to temp basal value for now

  /** `durationMinutes` is truncated to whole minutes like `UInt64(duration.minutes)`. */
  constructor(readonly rate: number, readonly durationMinutes: number) {
    super();
  }

  getRequestBytes(): Bytes {
    const minutes = Math.trunc(this.durationMinutes);
    if (minutes < 0 || minutes > 0xffff) throw new RangeError(`Medtrum: temp basal duration ${this.durationMinutes} min`);
    return concatBytes(new Uint8Array([this.type]), insulinU16(this.rate, 'temp basal rate'), toLeBytes(minutes, 2));
  }
  parseResponse(): BasalResponse {
    return parseBasalResponse(this.totalData);
  }
}

export class CancelTempBasalPacket extends MedtrumBasePacket<BasalResponse> {
  readonly commandType = CommandType.CANCEL_TEMP_BASAL;
  readonly minimumDataSize = 17;
  getRequestBytes(): Bytes {
    return empty();
  }
  parseResponse(): BasalResponse {
    return parseBasalResponse(this.totalData);
  }
}

// ── Suspend / resume / alarms ────────────────────────────────────────────────

export class SuspendPumpPacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.SUSPEND_PUMP;
  readonly minimumDataSize = 0;
  constructor(readonly durationMinutes: number) {
    super();
  }
  getRequestBytes(): Bytes {
    const minutes = Math.trunc(this.durationMinutes);
    // Swift: UInt8(duration.minutes) traps outside 0...255
    if (minutes < 0 || minutes > 255) throw new RangeError(`Medtrum: suspend duration ${this.durationMinutes} min (max 255)`);
    // 3 -> cause: unknown why this is 3
    return new Uint8Array([3, minutes]);
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

export class ResumePumpPacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.RESUME_PUMP;
  readonly minimumDataSize = 0;
  getRequestBytes(): Bytes {
    return empty();
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}

export class ClearAlertPacket extends MedtrumBasePacket<Record<string, never>> {
  readonly commandType = CommandType.CLEAR_ALARM;
  readonly minimumDataSize = 2;
  constructor(private readonly alertType: ClearAlarmType) {
    super();
  }
  getRequestBytes(): Bytes {
    return new Uint8Array([this.alertType & 0xff, (this.alertType >> 8) & 0xff]);
  }
  parseResponse(): Record<string, never> {
    return {};
  }
}
