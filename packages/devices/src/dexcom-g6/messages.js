/**
 * TypeScript port of Opcode.swift, NSData+CRC.swift and Messages/*.swift from
 * loopandlearn/CGMBLEKit (MIT, © 2015 Nathan Racklyeft, © LoopKit Authors).
 *
 * All multi-byte integers are little-endian. Rx parsers return `null` where the Swift
 * failable initialisers return `nil`.
 */
import { concatBytes, crc16CcittFalse, u16le, u32le, writeU16le, writeU32le } from '@buddy/core';
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
};
const KNOWN_OPCODES = new Set(Object.values(Opcode));
export const isKnownOpcode = (b) => b !== undefined && KNOWN_OPCODES.has(b);
const startsWith = (data, opcode) => data.length > 0 && data[0] === opcode;
// ── CRC ────────────────────────────────────────────────────────────────────────
/** CRC-CCITT (XModem): poly 0x1021, init 0x0000 — i.e. CCITT-FALSE with a zero seed. */
export const crc16 = (data) => crc16CcittFalse(data, 0);
export function isCrcValid(data) {
    if (data.length < 2)
        return false;
    return crc16(data.subarray(0, data.length - 2)) === u16le(data, data.length - 2);
}
export const appendingCrc = (data) => concatBytes(data, writeU16le(crc16(data)));
const op = (opcode) => new Uint8Array([opcode]);
// ── Tx messages ────────────────────────────────────────────────────────────────
/** 8 random bytes + end byte 0x2. Swift takes the first 8 bytes of a random UUID. */
export function authRequestTx(singleUseToken) {
    if (singleUseToken.length !== 8)
        throw new Error('Single-use token must be 8 bytes');
    return concatBytes(op(Opcode.authRequestTx), singleUseToken, new Uint8Array([0x2]));
}
export const authChallengeTx = (challengeHash) => concatBytes(op(Opcode.authChallengeTx), challengeHash);
export const keepAliveTx = (time) => new Uint8Array([Opcode.keepAlive, time & 0xff]);
export const bondRequestTx = () => op(Opcode.bondRequest);
export const disconnectTx = () => op(Opcode.disconnectTx);
export const transmitterTimeTx = () => appendingCrc(op(Opcode.transmitterTimeTx));
export const glucoseTx = () => appendingCrc(op(Opcode.glucoseTx));
export const calibrationDataTx = () => appendingCrc(op(Opcode.calibrationDataTx));
export const transmitterVersionTx = () => appendingCrc(op(Opcode.transmitterVersionTx));
export const resetTx = () => appendingCrc(op(Opcode.resetTx));
/** `startTime`: time since activation in Dex seconds; `secondsSince1970`: Unix time. */
export const sessionStartTx = (startTime, secondsSince1970) => appendingCrc(concatBytes(op(Opcode.sessionStartTx), writeU32le(startTime), writeU32le(secondsSince1970)));
export const sessionStopTx = (stopTime) => appendingCrc(concatBytes(op(Opcode.sessionStopTx), writeU32le(stopTime)));
export const calibrateGlucoseTx = (time, glucose) => appendingCrc(concatBytes(op(Opcode.calibrateGlucoseTx), writeU16le(glucose), writeU32le(time)));
export function glucoseBackfillTx(p) {
    const length = 0;
    const backfillCrc = 0;
    return appendingCrc(concatBytes(new Uint8Array([Opcode.glucoseBackfillTx, p.byte1, p.byte2, p.identifier]), writeU32le(p.startTime), writeU32le(p.endTime), writeU32le(length), writeU16le(backfillCrc)));
}
export function parseAuthRequestRx(data) {
    if (data.length < 17 || !startsWith(data, Opcode.authRequestRx))
        return null;
    return { tokenHash: data.slice(1, 9), challenge: data.slice(9, 17) };
}
export function parseAuthChallengeRx(data) {
    if (data.length < 3 || !startsWith(data, Opcode.authChallengeRx))
        return null;
    return { isAuthenticated: data[1] === 0x1, isBonded: data[2] === 0x1 };
}
/** Dexcom reports UInt32.max when no sensor session is active. */
export const NO_ACTIVE_SESSION_START_TIME = 0xffffffff;
export function parseTransmitterTimeRx(data) {
    if (data.length !== 16 || !isCrcValid(data) || !startsWith(data, Opcode.transmitterTimeRx))
        return null;
    return { status: data[1], currentTime: u32le(data, 2), sessionStartTime: u32le(data, 6) };
}
export const hasValidSensorSession = (t) => t.sessionStartTime !== NO_ACTIVE_SESSION_START_TIME && t.sessionStartTime <= t.currentTime;
export const GLUCOSE_SUB_MESSAGE_SIZE = 8;
export function parseGlucoseSubMessage(data, offset = 0) {
    if (data.length - offset < GLUCOSE_SUB_MESSAGE_SIZE)
        return null;
    const glucoseBytes = u16le(data, offset + 4);
    return {
        timestamp: u32le(data, offset),
        glucoseIsDisplayOnly: (glucoseBytes & 0xf000) > 0,
        glucose: glucoseBytes & 0xfff,
        state: data[offset + 6],
        trend: (data[offset + 7] << 24) >> 24,
    };
}
export const sameGlucoseSubMessage = (a, b) => a.timestamp === b.timestamp &&
    a.glucoseIsDisplayOnly === b.glucoseIsDisplayOnly &&
    a.glucose === b.glucose &&
    a.state === b.state &&
    a.trend === b.trend;
/** Accepts both the G5 (0x31) and the G6 (0x4f) glucose response. */
export function parseGlucoseRx(data) {
    if (data.length < 16 || !isCrcValid(data))
        return null;
    if (!startsWith(data, Opcode.glucoseRx) && !startsWith(data, Opcode.glucoseG6Rx))
        return null;
    const glucose = parseGlucoseSubMessage(data, 6);
    if (!glucose)
        return null;
    return { status: data[1], sequence: u32le(data, 2), glucose };
}
export function parseCalibrationDataRx(data) {
    if (data.length !== 19 || !isCrcValid(data) || !startsWith(data, Opcode.calibrationDataRx))
        return null;
    return { glucose: u16le(data, 11) & 0xfff, timestamp: u32le(data, 13) };
}
export const parseCalibrateGlucoseRx = (data) => data.length === 5 && isCrcValid(data) && startsWith(data, Opcode.calibrateGlucoseRx) ? { ok: true } : null;
function parseSessionRx(data, opcode) {
    if (data.length !== 17 || !isCrcValid(data) || !startsWith(data, opcode))
        return null;
    return {
        status: data[1],
        received: data[2],
        requestedTime: u32le(data, 3),
        sessionStartTime: u32le(data, 7),
        transmitterTime: u32le(data, 11),
    };
}
export const parseSessionStartRx = (data) => parseSessionRx(data, Opcode.sessionStartRx);
export const parseSessionStopRx = (data) => parseSessionRx(data, Opcode.sessionStopRx);
export const parseResetRx = (data) => data.length >= 2 && startsWith(data, Opcode.resetRx) ? { status: data[1] } : null;
export function parseTransmitterVersionRx(data) {
    if (data.length !== 19 || !isCrcValid(data) || !startsWith(data, Opcode.transmitterVersionRx))
        return null;
    return { status: data[1], firmwareVersion: Array.from(data.slice(2, 6)), transmitterExpiryInDays: u16le(data, 13) };
}
/** Heuristic borrowed from xDrip4iOS: Anubis-modded G6 transmitters report a 180-day expiry. */
export const isAnubis = (v) => v.transmitterExpiryInDays === 180;
export function parseGlucoseBackfillRx(data) {
    if (data.length !== 20 || !isCrcValid(data) || !startsWith(data, Opcode.glucoseBackfillRx))
        return null;
    return {
        status: data[1],
        backfillStatus: data[2],
        identifier: data[3],
        startTime: u32le(data, 4),
        endTime: u32le(data, 8),
        bufferLength: u32le(data, 12),
        bufferCrc: u16le(data, 16),
    };
}
