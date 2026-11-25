/**
 * TypeScript port of `SensorData.CalibrationInfo` (`LibreSensor/SensorContents/SensorData.swift`)
 * and of the keychain (de)serialisation in `LibreSensor/Calibration.swift` from
 * loopandlearn/LibreTransmitter (MIT, (c) the LibreTransmitter authors).
 */

/** Factory calibration parameters extracted from the (decrypted) FRAM. */
export interface CalibrationInfo {
  readonly i1: number;
  readonly i2: number;
  readonly i3: number;
  readonly i4: number;
  readonly i5: number;
  readonly i6: number;
  readonly extraSlope: number;
  readonly extraOffset: number;
  /** Byte-swapped footer CRC of the FRAM the parameters were read from. */
  readonly isValidForFooterWithReverseCRCs: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function serializeCalibration(c: CalibrationInfo): string {
  return JSON.stringify(c);
}

/** Returns `null` for anything that is not a complete calibration record (Swift silences errors too). */
export function deserializeCalibration(text: string | null): CalibrationInfo | null {
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const { i1, i2, i3, i4, i5, i6, isValidForFooterWithReverseCRCs } = o;
  if (!isNum(i1) || !isNum(i2) || !isNum(i3) || !isNum(i4) || !isNum(i5) || !isNum(i6) || !isNum(isValidForFooterWithReverseCRCs)) return null;
  // extraSlope / extraOffset are optional in Swift; both fall back together.
  const hasExtra = isNum(o.extraSlope) && isNum(o.extraOffset);
  return {
    i1, i2, i3, i4, i5, i6, isValidForFooterWithReverseCRCs,
    extraSlope: hasExtra ? (o.extraSlope as number) : 1,
    extraOffset: hasExtra ? (o.extraOffset as number) : 0,
  };
}
