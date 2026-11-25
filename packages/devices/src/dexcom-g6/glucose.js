/**
 * TypeScript port of Glucose.swift, CalibrationState.swift, TransmitterStatus.swift,
 * Calibration.swift and the trend mapping of Glucose+SensorDisplayable.swift from
 * loopandlearn/CGMBLEKit (MIT, © 2016 Nathan Racklyeft, © LoopKit Authors).
 *
 * Dates are epoch milliseconds. Transmitter times are seconds since transmitter activation,
 * so `date = activationDate + seconds × 1000`.
 */
import { clampGlucose, trendFromRate } from './ble-common';
import { hasValidSensorSession } from './messages';
export const DEFAULT_SENSOR_LIFE_DAYS = 10;
const DAY_MS = 24 * 3600 * 1000;
export const CalibrationState = {
    stopped: 1,
    warmup: 2,
    needFirstInitialCalibration: 4,
    needSecondInitialCalibration: 5,
    ok: 6,
    needCalibration7: 7,
    calibrationError8: 8,
    calibrationError9: 9,
    calibrationError10: 10,
    sensorFailure11: 11,
    sensorFailure12: 12,
    calibrationError13: 13,
    needCalibration14: 14,
    sessionFailure15: 15,
    sessionFailure16: 16,
    sessionFailure17: 17,
    questionMarks: 18,
};
/** Only ok / needCalibration7 / needCalibration14 carry a glucose value that may be used. Unknown states never do. */
export const hasReliableGlucose = (state) => state === CalibrationState.ok || state === CalibrationState.needCalibration7 || state === CalibrationState.needCalibration14;
export function calibrationStateName(state) {
    const entry = Object.entries(CalibrationState).find(([, v]) => v === state);
    return entry ? entry[0] : `.unknown(${state})`;
}
export const transmitterStatus = (raw) => (raw === 0 ? 'ok' : raw === 0x81 ? 'lowBattery' : { unknown: raw });
export function makeCalibration(message, activationDate) {
    if (message.glucose <= 0)
        return null;
    return { glucose: message.glucose, date: activationDate + message.timestamp * 1000 };
}
export function makeGlucose(p) {
    const { glucoseMessage: g, timeMessage, activationDate } = p;
    const sessionStartDate = hasValidSensorSession(timeMessage) ? activationDate + timeMessage.sessionStartTime * 1000 : null;
    const sessionExpDate = sessionStartDate === null ? null : sessionStartDate + (p.sensorLifeDays ?? DEFAULT_SENSOR_LIFE_DAYS) * DAY_MS;
    const reliable = hasReliableGlucose(g.state) && g.glucose >= 39;
    return {
        transmitterId: p.transmitterId,
        status: transmitterStatus(p.status),
        glucoseMessage: g,
        timeMessage,
        activationDate,
        sessionStartDate,
        sessionExpDate,
        readDate: activationDate + g.timestamp * 1000,
        lastCalibration: p.calibrationMessage ? makeCalibration(p.calibrationMessage, activationDate) : null,
        isDisplayOnly: g.glucoseIsDisplayOnly,
        state: g.state,
        glucose: reliable ? clampGlucose(g.glucose) : null,
        trend: g.trend,
        trendRate: g.trend < 127 && g.trend > -128 ? g.trend / 10 : null,
        syncIdentifier: `${p.transmitterId} ${g.timestamp}`,
    };
}
/** LoopKit `trendType`: unknown at Int8.max, otherwise thresholds at ±10/20/30 (×10 mg/dL/min). */
export const g6Trend = (g) => (g.trend >= 127 ? 'unknown' : trendFromRate(g.trend / 10));
