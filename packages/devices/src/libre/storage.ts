/**
 * Persistence for the Libre drivers. Replaces the UserDefaults / keychain storage of
 * `LibreSensor/SensorContents/Sensor.swift` (`Sensor`, `CalibrationToSensorMapping`,
 * `preSelectedSensor`, `calibrationMapping`) and `LibreSensor/Calibration.swift` from
 * loopandlearn/LibreTransmitter (MIT, (c) the LibreTransmitter authors) with Buddy's `SecretStore`.
 */
import { fromHex, hex, type SecretStore } from '@buddy/core';
import { deserializeCalibration, serializeCalibration, type CalibrationInfo } from './calibration';
import type { Libre2Sensor } from './libre2-direct';
import type { CalibrationMapping, CalibrationStore } from './processor';

export const LIBRE_SECRET_KEYS = {
  libre2Sensor: 'libre2.sensor',
  libre2Calibration: 'libre2.calibration',
  libre2CalibrationMapping: 'libre2.calibrationMapping',
  libre2DeviceId: 'libre2.deviceId',
  transmitterCalibration: 'libre-transmitter.calibration',
  transmitterDeviceId: 'libre-transmitter.deviceId',
} as const;

interface StoredSensor {
  uid: string;
  patchInfo: string;
  maxAge: number;
  unlockCount: number;
  macAddress: string | null;
  serialNumber: string | null;
}

const isHex = (v: unknown, bytes: number): v is string => typeof v === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(v);

export async function loadLibre2Sensor(secrets: SecretStore): Promise<Libre2Sensor | null> {
  const raw = await secrets.get(LIBRE_SECRET_KEYS.libre2Sensor);
  if (!raw) return null;
  let v: Partial<StoredSensor>;
  try {
    v = JSON.parse(raw) as Partial<StoredSensor>;
  } catch {
    return null;
  }
  if (!isHex(v.uid, 8) || !isHex(v.patchInfo, 6) || typeof v.unlockCount !== 'number' || typeof v.maxAge !== 'number') return null;
  return {
    uid: fromHex(v.uid),
    patchInfo: fromHex(v.patchInfo),
    maxAge: v.maxAge,
    unlockCount: v.unlockCount,
    macAddress: typeof v.macAddress === 'string' ? v.macAddress : null,
    serialNumber: typeof v.serialNumber === 'string' ? v.serialNumber : null,
  };
}

export async function saveLibre2Sensor(secrets: SecretStore, s: Libre2Sensor): Promise<void> {
  const stored: StoredSensor = { uid: hex(s.uid), patchInfo: hex(s.patchInfo), maxAge: s.maxAge, unlockCount: s.unlockCount, macAddress: s.macAddress, serialNumber: s.serialNumber };
  await secrets.set(LIBRE_SECRET_KEYS.libre2Sensor, JSON.stringify(stored));
}

export async function loadCalibrationMapping(secrets: SecretStore): Promise<CalibrationMapping | null> {
  const raw = await secrets.get(LIBRE_SECRET_KEYS.libre2CalibrationMapping);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CalibrationMapping>;
    return isHex(v.uuidHex, 8) && typeof v.reverseFooterCRC === 'number' ? { uuidHex: v.uuidHex.toLowerCase(), reverseFooterCRC: v.reverseFooterCRC } : null;
  } catch {
    return null;
  }
}

export async function saveCalibrationMapping(secrets: SecretStore, m: CalibrationMapping): Promise<void> {
  await secrets.set(LIBRE_SECRET_KEYS.libre2CalibrationMapping, JSON.stringify(m));
}

export function calibrationStore(secrets: SecretStore, key: string): CalibrationStore {
  return {
    get: async (): Promise<CalibrationInfo | null> => deserializeCalibration(await secrets.get(key)),
    set: (c: CalibrationInfo) => secrets.set(key, serializeCalibration(c)),
  };
}
