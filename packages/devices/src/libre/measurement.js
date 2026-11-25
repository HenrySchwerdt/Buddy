/**
 * TypeScript port of `LibreSensor/SensorContents/Measurement.swift` and
 * `LibreSensor/GlucoseAlgorithm/GlucoseFromRaw.swift` from loopandlearn/LibreTransmitter
 * (MIT, (c) Uwe Petersen and the LibreTransmitter authors).
 */
import { readBits } from './bits';
import { T1, T2 } from './glucose-tables';
export const MeasurementError = {
    OK: 0,
    SD14_FIFO_OVERFLOW: 0x01,
    FILTER_DELTA: 0x02,
    WORK_VOLTAGE: 0x04,
    PEAK_DELTA_EXCEEDED: 0x08,
    AVG_DELTA_EXCEEDED: 0x10,
    RF: 0x20,
    REF_R: 0x40,
    SIGNAL_SATURATED: 0x80,
    SENSOR_SIGNAL_LOW: 0x100,
    THERMISTOR_OUT_OF_RANGE: 0x800,
    TEMP_HIGH: 0x2000,
    TEMP_LOW: 0x4000,
    INVALID_DATA: 0x8000,
};
const ALL_ERROR_CODES = Object.values(MeasurementError).filter((e) => e !== 0);
/** `Measurement.extractErrorBitField`. */
export function extractErrorBitField(errBitField) {
    return errBitField === 0 ? [MeasurementError.OK] : ALL_ERROR_CODES.filter((e) => (errBitField & e) !== 0);
}
/** `Measurement(date:rawGlucose:rawTemperature:rawTemperatureAdjustment:idValue:)`. */
export function createMeasurement(p) {
    return { ...p, idValue: p.idValue ?? 0, bytes: [], counter: 0, error: [MeasurementError.OK] };
}
/** `Measurement(bytes:slope:offset:counter:date:idValue:)` from a 6-byte FRAM record. */
export function measurementFromBytes(bytes, date, counter = 0, idValue = 0) {
    const temperatureAdjustment = readBits(bytes, 0, 0x26, 0x9) << 2;
    const negativeAdjustment = readBits(bytes, 0, 0x2f, 0x1) !== 0;
    return {
        date,
        counter,
        idValue,
        bytes: Array.from(bytes),
        rawGlucose: readBits(bytes, 0, 0, 0xe),
        // raw temperature in libre FRAM is always stored in multiples of four
        rawTemperature: readBits(bytes, 0, 0x1a, 0xc) << 2,
        rawTemperatureAdjustment: negativeAdjustment ? -temperatureAdjustment : temperatureAdjustment,
        error: extractErrorBitField(readBits(bytes, 0, 0xe, 0xc)),
    };
}
export const hasMeasurementError = (m) => m.error.some((e) => e !== MeasurementError.OK);
/** Swift/C `round()`: half away from zero (JS `Math.round` rounds -0.5 up). */
export const roundHalfAwayFromZero = (x) => Math.sign(x) * Math.round(Math.abs(x));
/**
 * `glucoseValueFromRaw(calibrationInfo:)`: temperature-compensated glucose (mg/dL) from the
 * raw sensor values and the factory calibration. Returns NaN where Swift would trap
 * (calibration index outside the lookup tables).
 */
export function glucoseValueFromRaw(m, c) {
    const x = 1000 + 71500;
    const y = 1000;
    const ca = 0.0009180023;
    const cb = 0.0001964561;
    const cc = 0.0000007061775;
    const cd = 0.00000005283566;
    const R = (m.rawTemperature * x) / (m.rawTemperatureAdjustment + c.i6) - y;
    const logR = Math.log(R);
    const d = Math.pow(logR, 3) * cd + Math.pow(logR, 2) * cc + logR * cb + ca;
    const temperature = 1 / d - 273.15;
    const g1 = (65.0 * (m.rawGlucose - c.i3)) / (c.i4 - c.i3);
    const g2 = Math.pow(1.045, 32.5 - temperature);
    const g3 = g1 * g2;
    const v1 = T1[c.i2 - 1];
    const v2 = T2[c.i2 - 1];
    if (v1 === undefined || v2 === undefined)
        return Number.NaN;
    return (g3 - v1) / v2;
}
/** `calibratedGlucose(calibrationInfo:)`: rounded value with the user's extra slope/offset applied. */
export function calibratedGlucose(m, c) {
    return roundHalfAwayFromZero(glucoseValueFromRaw(m, c)) * c.extraSlope + c.extraOffset;
}
