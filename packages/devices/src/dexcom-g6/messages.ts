/**
 * TypeScript port of Opcode.swift, NSData+CRC.swift and Messages/*.swift from
 * loopandlearn/CGMBLEKit (MIT, © 2015 Nathan Racklyeft, © LoopKit Authors).
 *
 * All multi-byte integers are little-endian. Rx parsers return `null` where the Swift
 * failable initialisers return `nil`.
 */
import { concatBytes, crc16CcittFalse, u16le, u32le, writeU16le, writeU32le, type Bytes } from '@buddy/core';

export const Opcode = {
  // Auth
  authRequestTx: 0x01,
  authRequestRx: 0x03,
  authChallengeTx: 0x04,
  authChallengeRx: 0x05,
  keepAlive: 0x06, // auth; setAdvertisementParametersTx for control
  bondRequest: 0x07,
  // Control
  disconnectTx: 0x09,
  setAdvertisementParametersRx: 0x1c,
  firmwareVersionTx: 0x20,
  firmwareVersionRx: 0x21,
  batteryStatusTx: 0x22,
  batteryStatusRx: 0x23,
  transmitterTimeTx: 0x24,
  transmitterTimeRx: 0x25,
  sessionStartTx: 0x26,
  sessionStartRx: 0x27,
  sessionStopTx: 0x28,
  sessionStopRx: 0x29,
  glucoseTx: 0x30,
  glucoseRx: 0x31,
  calibrationDataTx: 0x32,
  calibrationDataRx: 0x33,
  calibrateGlucoseTx: 0x34,
  calibrateGlucoseRx: 0x35,
  glucoseHistoryTx: 0x3e,
  resetTx: 0x42,
  resetRx: 0x43,
  transmitterVersionTx: 0x4a,
  transmitterVersionRx: 0x4b,
  glucoseG6Tx: 0x4e,
  glucoseG6Rx: 0x4f,
  glucoseBackfillTx: 0x50,
  glucoseBackfillRx: 0x51,
} as const;

const KNOWN_OPCODES: ReadonlySet<number> = new Set(Object.values(Opcode));
export const isKnownOpcode = (b: number | undefined): boolean => b !== undefined && KNOWN_OPCODES.has(b);

const startsWith = (data: Bytes, opcode: number): boolean => data.length > 0 && data[0] === opcode;

// ── CRC ────────────────────────────────────────────────────────────────────────

/** CRC-CCITT (XModem): poly 0x1021, init 0x0000 — i.e. CCITT-FALSE with a zero seed. */
export const crc16 = (data: Bytes): number => crc16CcittFalse(data, 0);

export function isCrcValid(data: Bytes): boolean {
  if (data.length < 2) return false;
  return crc16(data.subarray(0, data.length - 2)) === u16le(data, data.length - 2);
}

export const appendingCrc = (data: Bytes): Bytes => concatBytes(data, writeU16le(crc16(data)));

const op = (opcode: number): Bytes => new Uint8Array([opcode]);

// ── Tx messages ────────────────────────────────────────────────────────────────

/** 8 random bytes + end byte 0x2. Swift takes the first 8 bytes of a random UUID. */
export function authRequestTx(singleUseToken: Bytes): Bytes {
  if (singleUseToken.length !== 8) throw new Error('Single-use token must be 8 bytes');
  return concatBytes(op(Opcode.authRequestTx), singleUseToken, new Uint8Array([0x2]));
}

export const authChallengeTx = (challengeHash: Bytes): Bytes => concatBytes(op(Opcode.authChallengeTx), challengeHash);
export const keepAliveTx = (time: number): Bytes => new Uint8Array([Opcode.keepAlive, time & 0xff]);
export const bondRequestTx = (): Bytes => op(Opcode.bondRequest);
export const disconnectTx = (): Bytes => op(Opcode.disconnectTx);
export const transmitterTimeTx = (): Bytes => appendingCrc(op(Opcode.transmitterTimeTx));
export const glucoseTx = (): Bytes => appendingCrc(op(Opcode.glucoseTx));
export const calibrationDataTx = (): Bytes => appendingCrc(op(Opcode.calibrationDataTx));
export const transmitterVersionTx = (): Bytes => appendingCrc(op(Opcode.transmitterVersionTx));
export const resetTx = (): Bytes => appendingCrc(op(Opcode.resetTx));

/** `startTime`: time since activation in Dex seconds; `secondsSince1970`: Unix time. */
export const sessionStartTx = (startTime: number, secondsSince1970: number): Bytes =>
  appendingCrc(concatBytes(op(Opcode.sessionStartTx), writeU32le(startTime), writeU32le(secondsSince1970)));

export const sessionStopTx = (stopTime: number): Bytes => appendingCrc(concatBytes(op(Opcode.sessionStopTx), writeU32le(stopTime)));

export const calibrateGlucoseTx = (time: number, glucose: number): Bytes =>
  appendingCrc(concatBytes(op(Opcode.calibrateGlucoseTx), writeU16le(glucose), writeU32le(time)));

export function glucoseBackfillTx(p: { byte1: number; byte2: number; identifier: number; startTime: number; endTime: number }): Bytes {
  const length = 0;
  const backfillCrc = 0;
  return appendingCrc(
    concatBytes(
      new Uint8Array([Opcode.glucoseBackfillTx, p.byte1, p.byte2, p.identifier]),
      writeU32le(p.startTime),
      writeU32le(p.endTime),
      writeU32le(length),
      writeU16le(backfillCrc),
    ),
  );
}

// ── Rx messages ────────────────────────────────────────────────────────────────

export interface AuthRequestRx {
  readonly tokenHash: Bytes;
  readonly challenge: Bytes;
}

export function parseAuthRequestRx(data: Bytes): AuthRequestRx | null {
  if (data.length < 17 || !startsWith(data, Opcode.authRequestRx)) return null;
  return { tokenHash: data.slice(1, 9), challenge: data.slice(9, 17) };
}

export interface AuthChallengeRx {
  readonly isAuthenticated: boolean;
  readonly isBonded: boolean;
}

export function parseAuthChallengeRx(data: Bytes): AuthChallengeRx | null {
  if (data.length < 3 || !startsWith(data, Opcode.authChallengeRx)) return null;
  return { isAuthenticated: data[1] === 0x1, isBonded: data[2] === 0x1 };
}

/** Dexcom reports UInt32.max when no sensor session is active. */
export const NO_ACTIVE_SESSION_START_TIME = 0xffffffff;

export interface TransmitterTimeRx {
  readonly status: number;
  /** Seconds since transmitter activation. */
  readonly currentTime: number;
  readonly sessionStartTime: number;
}

export function parseTransmitterTimeRx(data: Bytes): TransmitterTimeRx | null {
  if (data.length !== 16 || !isCrcValid(data) || !startsWith(data, Opcode.transmitterTimeRx)) return null;
  return { status: data[1]!, currentTime: u32le(data, 2), sessionStartTime: u32le(data, 6) };
}

export const hasValidSensorSession = (t: TransmitterTimeRx): boolean =>
  t.sessionStartTime !== NO_ACTIVE_SESSION_START_TIME && t.sessionStartTime <= t.currentTime;

export interface GlucoseSubMessage {
  /** Seconds since transmitter activation. */
  readonly timestamp: number;
  readonly glucoseIsDisplayOnly: boolean;
  readonly glucose: number;
  readonly state: number;
  /** Signed rate ×10 mg/dL/min; 127 (Int8.max) = unknown. */
  readonly trend: number;
}

export const GLUCOSE_SUB_MESSAGE_SIZE = 8;

export function parseGlucoseSubMessage(data: Bytes, offset = 0): GlucoseSubMessage | null {
  if (data.length - offset < GLUCOSE_SUB_MESSAGE_SIZE) return null;
  const glucoseBytes = u16le(data, offset + 4);
  return {
    timestamp: u32le(data, offset),
    glucoseIsDisplayOnly: (glucoseBytes & 0xf000) > 0,
    glucose: glucoseBytes & 0xfff,
    state: data[offset + 6]!,
    trend: (data[offset + 7]! << 24) >> 24,
  };
}

export const sameGlucoseSubMessage = (a: GlucoseSubMessage, b: GlucoseSubMessage): boolean =>
  a.timestamp === b.timestamp &&
  a.glucoseIsDisplayOnly === b.glucoseIsDisplayOnly &&
  a.glucose === b.glucose &&
  a.state === b.state &&
  a.trend === b.trend;

export interface GlucoseRx {
  readonly status: number;
  readonly sequence: number;
  readonly glucose: GlucoseSubMessage;
}

/** Accepts both the G5 (0x31) and the G6 (0x4f) glucose response. */
export function parseGlucoseRx(data: Bytes): GlucoseRx | null {
  if (data.length < 16 || !isCrcValid(data)) return null;
  if (!startsWith(data, Opcode.glucoseRx) && !startsWith(data, Opcode.glucoseG6Rx)) return null;
  const glucose = parseGlucoseSubMessage(data, 6);
  if (!glucose) return null;
  return { status: data[1]!, sequence: u32le(data, 2), glucose };
}

export interface CalibrationDataRx {
  readonly glucose: number;
  readonly timestamp: number;
}

export function parseCalibrationDataRx(data: Bytes): CalibrationDataRx | null {
  if (data.length !== 19 || !isCrcValid(data) || !startsWith(data, Opcode.calibrationDataRx)) return null;
  return { glucose: u16le(data, 11) & 0xfff, timestamp: u32le(data, 13) };
}

export const parseCalibrateGlucoseRx = (data: Bytes): { readonly ok: true } | null =>
  data.length === 5 && isCrcValid(data) && startsWith(data, Opcode.calibrateGlucoseRx) ? { ok: true } : null;

export interface SessionRx {
  readonly status: number;
  readonly received: number;
  /** Requested start (start message) or stop time (stop message). I've only seen these 2 values matching. */
  readonly requestedTime: number;
  readonly sessionStartTime: number;
  readonly transmitterTime: number;
}

function parseSessionRx(data: Bytes, opcode: number): SessionRx | null {
  if (data.length !== 17 || !isCrcValid(data) || !startsWith(data, opcode)) return null;
  return {
    status: data[1]!,
    received: data[2]!,
    requestedTime: u32le(data, 3),
    sessionStartTime: u32le(data, 7),
    transmitterTime: u32le(data, 11),
  };
}

export const parseSessionStartRx = (data: Bytes): SessionRx | null => parseSessionRx(data, Opcode.sessionStartRx);
export const parseSessionStopRx = (data: Bytes): SessionRx | null => parseSessionRx(data, Opcode.sessionStopRx);

export const parseResetRx = (data: Bytes): { readonly status: number } | null =>
  data.length >= 2 && startsWith(data, Opcode.resetRx) ? { status: data[1]! } : null;

export interface TransmitterVersionRx {
  readonly status: number;
  readonly firmwareVersion: readonly number[];
  /** Lifetime the transmitter reports for itself (stock G6 = 90, Anubis-modded G6 = 180). */
  readonly transmitterExpiryInDays: number;
}

export function parseTransmitterVersionRx(data: Bytes): TransmitterVersionRx | null {
  if (data.length !== 19 || !isCrcValid(data) || !startsWith(data, Opcode.transmitterVersionRx)) return null;
  return { status: data[1]!, firmwareVersion: Array.from(data.slice(2, 6)), transmitterExpiryInDays: u16le(data, 13) };
}

/** Heuristic borrowed from xDrip4iOS: Anubis-modded G6 transmitters report a 180-day expiry. */
export const isAnubis = (v: { readonly transmitterExpiryInDays: number }): boolean => v.transmitterExpiryInDays === 180;

export interface GlucoseBackfillRx {
  readonly status: number;
  readonly backfillStatus: number;
  readonly identifier: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly bufferLength: number;
  readonly bufferCrc: number;
}

export function parseGlucoseBackfillRx(data: Bytes): GlucoseBackfillRx | null {
  if (data.length !== 20 || !isCrcValid(data) || !startsWith(data, Opcode.glucoseBackfillRx)) return null;
  return {
    status: data[1]!,
    backfillStatus: data[2]!,
    identifier: data[3]!,
    startTime: u32le(data, 4),
    endTime: u32le(data, 8),
    bufferLength: u32le(data, 12),
    bufferCrc: u16le(data, 16),
  };
}
