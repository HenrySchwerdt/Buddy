/**
 * TypeScript port of Messages/G7Opcode.swift, Messages/G7GlucoseMessage.swift,
 * Messages/ExtendedVersionMessage.swift, Messages/AuthChallengeRxMessage.swift,
 * G7CGMManager/G7BackfillMessage.swift and AlgorithmState.swift from
 * loopandlearn/G7SensorKit (MIT, © 2022 LoopKit Authors).
 *
 * All multi-byte integers are little-endian. Times are seconds since sensor pairing/activation.
 */
import { hex, u16le, u32le } from '@buddy/core';
import { trendFromRate } from '../dexcom-g6/ble-common';
export const G7Opcode = {
    authChallengeRx: 0x05,
    sessionStopTx: 0x28,
    glucoseTx: 0x4e,
    extendedVersionTx: 0x52,
    extendedVersionRx: 0x53,
    backfillFinished: 0x59,
};
const startsWith = (data, opcode) => data.length > 0 && data[0] === opcode;
// ── AlgorithmState ─────────────────────────────────────────────────────────────
export const AlgorithmState = {
    stopped: 1,
    warmup: 2,
    excessNoise: 3,
    firstOfTwoBGsNeeded: 4,
    secondOfTwoBGsNeeded: 5,
    ok: 6,
    needsCalibration: 7,
    calibrationError1: 8,
    calibrationError2: 9,
    calibrationLinearityFitFailure: 10,
    sensorFailedDuetoCountsAberration: 11,
    sensorFailedDuetoResidualAberration: 12,
    outOfCalibrationDueToOutlier: 13,
    outlierCalibrationRequest: 14,
    sessionExpired: 15,
    sessionFailedDueToUnrecoverableError: 16,
    sessionFailedDueToTransmitterError: 17,
    temporarySensorIssue: 18,
    sensorFailedDueToProgressiveSensorDecline: 19,
    sensorFailedDueToHighCountsAberration: 20,
    sensorFailedDueToLowCountsAberration: 21,
    sensorFailedDueToRestart: 22,
    expired: 24,
    sensorFailed: 25,
    sessionEnded: 26,
};
const S = AlgorithmState;
const FAILED = new Set([
    S.sensorFailed,
    S.sensorFailedDuetoCountsAberration,
    S.sensorFailedDuetoResidualAberration,
    S.sessionFailedDueToTransmitterError,
    S.sessionFailedDueToUnrecoverableError,
    S.sensorFailedDueToProgressiveSensorDecline,
    S.sensorFailedDueToHighCountsAberration,
    S.sensorFailedDueToLowCountsAberration,
    S.sensorFailedDueToRestart,
]);
export const algorithmSensorFailed = (state) => FAILED.has(state);
export const algorithmIsInWarmup = (state) => state === S.warmup;
export const algorithmHasTemporaryError = (state) => state === S.temporarySensorIssue;
/** Only `ok` carries a glucose value that may be used; unknown states never do. */
export const algorithmHasReliableGlucose = (state) => state === S.ok;
export function algorithmStateName(state) {
    const entry = Object.entries(AlgorithmState).find(([, v]) => v === state);
    return entry ? entry[0] : `.unknown(${state})`;
}
export function parseAuthChallengeRx(data) {
    if (data.length < 3 || !startsWith(data, G7Opcode.authChallengeRx))
        return null;
    return { isAuthenticated: data[1] === 0x1, isBonded: data[2] === 0x1 };
}
export function parseExtendedVersionMessage(data) {
    // 10-day: 52 00 c0d70d00 5406 00020404 ff 0c00
    // 15-day: 52 00 406f1400 880e 00010a04 ff 1100
    if (!startsWith(data, G7Opcode.extendedVersionTx) || data.length < 15)
        return null;
    return {
        sessionLength: u32le(data, 2),
        warmupDuration: u16le(data, 6),
        algorithmVersion: u32le(data, 8),
        hardwareVersion: data[12],
        maxLifetimeDays: u16le(data, 13),
        data: data.slice(),
    };
}
// ── Glucose ────────────────────────────────────────────────────────────────────
/** Rate (mg/dL/min) or `null` when the sensor reports 0x7f. */
const trendByte = (b) => (b === 0x7f ? null : ((b << 24) >> 24) / 10);
export function parseG7GlucoseMessage(data) {
    //    0  1  2 3 4 5  6 7  8  9 1011 1213 14 15 1617 18
    //         TTTTTTTT SQSQ       AGAG BGBG SS TR PRPR C
    // 0x4e 00 d5070000 0900 00 01 0500 6100 06 01 ffff 0e
    // TTTTTTTT = timestamp
    //     SQSQ = sequence
    //     AGAG = age
    //     BGBG = glucose
    //       SS = algorithm state
    //       TR = trend
    //     PRPR = predicted
    //        C = calibration
    if (data.length < 19 || data[1] !== 0x00)
        return null;
    const glucoseData = u16le(data, 12);
    const hasGlucose = glucoseData !== 0xffff;
    const predictionData = u16le(data, 16);
    return {
        messageTimestamp: u32le(data, 2),
        sequence: u16le(data, 6),
        age: u16le(data, 10),
        glucose: hasGlucose ? glucoseData & 0xfff : null,
        glucoseIsDisplayOnly: hasGlucose ? (data[18] & 0x10) > 0 : false,
        predicted: predictionData !== 0xffff ? predictionData & 0xfff : null,
        algorithmState: data[14],
        trend: trendByte(data[15]),
        data: data.slice(),
    };
}
/** Seconds since pairing at which the glucose was measured (clamped at 0 instead of UInt32 underflow). */
export const glucoseTimestamp = (m) => Math.max(0, m.messageTimestamp - m.age);
export const sameG7Message = (a, b) => a !== null && b !== null && hex(a.data) === hex(b.data);
/** LoopKit trend thresholds at ±1/2/3 mg/dL/min. */
export const g7Trend = (m) => trendFromRate(m.trend);
export function parseG7BackfillMessage(data) {
    //    0 1 2  3  4 5  6  7  8
    //   TTTTTT    BGBG SS    TR
    //   45a100 00 9600 06 0f fc
    if (data.length !== 9)
        return null;
    // Swift reads a UInt32 from a 3-byte slice; only the 24-bit value is defined.
    const timestamp = data[0] | (data[1] << 8) | (data[2] << 16);
    const glucoseBytes = u16le(data, 4);
    return {
        timestamp,
        glucose: glucoseBytes !== 0xffff ? glucoseBytes & 0xfff : null,
        glucoseIsDisplayOnly: (data[7] & 0x10) !== 0,
        algorithmState: data[6],
        trend: trendByte(data[8]),
        data: data.slice(),
    };
}
