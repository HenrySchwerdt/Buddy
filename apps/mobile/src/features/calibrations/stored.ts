import { LIBRE_SECRET_KEYS } from '@buddy/devices';

/** Shape of `CalibrationInfo` in @buddy/devices (the type is not re-exported from the package root). */
export interface CalibrationInfo {
  readonly i1: number;
  readonly i2: number;
  readonly i3: number;
  readonly i4: number;
  readonly i5: number;
  readonly i6: number;
  readonly extraSlope: number;
  readonly extraOffset: number;
  readonly isValidForFooterWithReverseCRCs: number;
}

/** Read-only view of the factory calibration the Libre drivers keep in the keychain. */
export interface StoredCalibration {
  readonly label: string;
  readonly key: string;
  readonly info: CalibrationInfo | null;
}

export const CALIBRATION_SOURCES = [
  { label: 'Libre 2 (direct)', key: LIBRE_SECRET_KEYS.libre2Calibration },
  { label: 'Libre transmitter', key: LIBRE_SECRET_KEYS.transmitterCalibration },
] as const;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Parses the JSON the Libre drivers store (same rules as the driver: all six factory parameters
 * and the footer CRC are required, extra slope/offset fall back together to 1 / 0).
 */
export function parseStoredCalibration(text: string | null): CalibrationInfo | null {
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
  const hasExtra = isNum(o.extraSlope) && isNum(o.extraOffset);
  return { i1, i2, i3, i4, i5, i6, isValidForFooterWithReverseCRCs, extraSlope: hasExtra ? (o.extraSlope as number) : 1, extraOffset: hasExtra ? (o.extraOffset as number) : 0 };
}

/** Footer CRC as the 4-digit hex the Libre tools print. */
export const formatCrc = (crc: number): string => (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');

/** Loads every stored calibration; storage errors count as "none stored". */
export async function loadStoredCalibrations(get: (key: string) => Promise<string | null>): Promise<StoredCalibration[]> {
  return Promise.all(
    CALIBRATION_SOURCES.map(async ({ label, key }) => {
      try {
        return { label, key, info: parseStoredCalibration(await get(key)) };
      } catch {
        return { label, key, info: null };
      }
    }),
  );
}
