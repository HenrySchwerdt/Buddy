/**
 * TypeScript port of `SensorData.CalibrationInfo` (`LibreSensor/SensorContents/SensorData.swift`)
 * and of the keychain (de)serialisation in `LibreSensor/Calibration.swift` from
 * loopandlearn/LibreTransmitter (MIT, (c) the LibreTransmitter authors).
 */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export function serializeCalibration(c) {
    return JSON.stringify(c);
}
/** Returns `null` for anything that is not a complete calibration record (Swift silences errors too). */
export function deserializeCalibration(text) {
    if (!text)
        return null;
    let v;
    try {
        v = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof v !== 'object' || v === null)
        return null;
    const o = v;
    const { i1, i2, i3, i4, i5, i6, isValidForFooterWithReverseCRCs } = o;
    if (!isNum(i1) || !isNum(i2) || !isNum(i3) || !isNum(i4) || !isNum(i5) || !isNum(i6) || !isNum(isValidForFooterWithReverseCRCs))
        return null;
    // extraSlope / extraOffset are optional in Swift; both fall back together.
    const hasExtra = isNum(o.extraSlope) && isNum(o.extraOffset);
    return {
        i1, i2, i3, i4, i5, i6, isValidForFooterWithReverseCRCs,
        extraSlope: hasExtra ? o.extraSlope : 1,
        extraOffset: hasExtra ? o.extraOffset : 0,
    };
}
