/**
 * TypeScript port of SyaiCoefficientDecipher.swift, SyaiApplicatorCode.swift, DeviceInfo.swift
 * and the parsing half of SyaiBoundSensorLookup.swift / SyaiServerCalibrationProvider.swift from
 * SyaiKit (MIT, © 2026 Nightscout Foundation).
 *
 * A sensor's calibration (14 coefficients) and BLE key group arrive from the Syai account,
 * AES-256-ECB wrapped under `glucoseSecretKey | last10(updateTime) | last6(mac)`. There is no
 * default fallback: decoding on anything but the sensor's own coefficients would put
 * plausible-but-wrong glucose into the loop.
 */
import type { Bytes } from '@buddy/core';
import { ecb } from '@noble/ciphers/aes.js';
import { base64Decode, hexDecode, utf8Decode, utf8Encode } from './bytes';
import { COEFFICIENT_COUNT } from './rpn';
import { SyaiFailure } from './errors';
import { KEY_GROUP_BYTES } from './ble-auth';

export interface SyaiDeviceInfo {
  readonly mac: string;
  readonly serialNo: string;
  readonly batchNo: string;
  readonly deviceType: string;
  /** Server-style firmware version, e.g. `V1.7.SH22601.3`. */
  readonly deviceVersion: string;
  /** C0..C13, exactly 14. */
  readonly coefficients: readonly number[];
  /** Wear window length in seconds. */
  readonly activeDurationSec: number;
  /** Warmup length in seconds. */
  readonly preheatDurationSec: number;
}

export interface BoundSensor {
  readonly deviceInfo: SyaiDeviceInfo;
  /** 96 raw bytes: six 16-byte keys. */
  readonly keyGroup: Bytes;
  /** Epoch ms from the server's `activeTime`, null if not reported. */
  readonly activatedAt: number | null;
}

/** The sensor MAC in the form BLE discovery reports (12 upper-case hex digits), or null. */
export function macFromApplicatorCode(payload: string): string | null {
  const stripped = payload.trim().replace(/[:-]/g, '');
  return /^[0-9a-fA-F]{12}$/.test(stripped) ? stripped.toUpperCase() : null;
}

/** MAC as advertised in the manufacturer data: company id (2 B) then the 6 MAC bytes. */
export function advertisedMac(manufacturerData: Bytes | null): string | null {
  if (!manufacturerData || manufacturerData.length <= 2) return null;
  return Array.from(manufacturerData.slice(2), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** `glucoseSecretKey + last10(updateTime) + last6(mac)`; a 16-char account key makes 32 bytes (AES-256). */
export const deriveWrapKey = (glucoseSecretKey: string, updateTime: number, mac: string): string =>
  glucoseSecretKey + String(updateTime).slice(-10) + mac.slice(-6);

function unwrap(base64: string, key: string, what: string): Bytes {
  const ct = base64Decode(base64);
  if (!ct) throw new SyaiFailure('noCalibration', `${what}: not valid base64`);
  const keyBytes = utf8Encode(key);
  if (![16, 24, 32].includes(keyBytes.length)) throw new SyaiFailure('noCalibration', `${what}: wrap key must be 16/24/32 bytes, got ${keyBytes.length}`);
  try {
    return ecb(keyBytes).decrypt(ct);
  } catch {
    throw new SyaiFailure('noCalibration', `${what}: decrypt failed`);
  }
}

export function parseCoefficients(plaintext: string): number[] {
  const parts = plaintext.trim().split(',').map((s) => s.trim());
  if (parts.length !== COEFFICIENT_COUNT) throw new SyaiFailure('noCalibration', `coefficient: expected ${COEFFICIENT_COUNT} values, got ${parts.length}`);
  return parts.map((s) => {
    const v = s === '' ? NaN : Number(s);
    if (!Number.isFinite(v)) throw new SyaiFailure('noCalibration', `coefficient: non-numeric value '${s}'`);
    return v;
  });
}

export function decipherCoefficients(base64Coefficient: string, coeffUpdateTime: number, mac: string, glucoseSecretKey: string): number[] {
  const plain = unwrap(base64Coefficient, deriveWrapKey(glucoseSecretKey, coeffUpdateTime, mac), 'coefficient');
  return parseCoefficients(utf8Decode(plain));
}

/** `keyA` uses the same KDF with `produceTime`; the plaintext is 96 raw bytes or 192 hex characters. */
export function decipherKeyGroup(base64KeyA: string, produceTime: number, mac: string, glucoseSecretKey: string): Bytes {
  const plain = unwrap(base64KeyA, deriveWrapKey(glucoseSecretKey, produceTime, mac), 'keyA');
  if (plain.length === KEY_GROUP_BYTES) return plain;
  if (plain.length === 2 * KEY_GROUP_BYTES) {
    const raw = hexDecode(utf8Decode(plain));
    if (raw && raw.length === KEY_GROUP_BYTES) return raw;
  }
  throw new SyaiFailure('noCalibration', `keyA plaintext ${plain.length}B, expected 96 raw or 192 hex`);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Parses a bound-sensor body (`getBindDevice` merged with `authInfo`). Every field the decode
 * depends on is required.
 */
export function parseBoundSensor(body: Readonly<Record<string, unknown>>, glucoseSecretKey: string | null): BoundSensor {
  const mac = str(body.mac);
  if (!mac) throw new SyaiFailure('noCalibration', "Couldn't read your bound sensor: no 'mac'");
  if (!glucoseSecretKey) throw new SyaiFailure('notConfigured', 'Missing glucoseSecretKey; log in again.');
  const keyA = str(body.keyA);
  const produceTime = num(body.produceTime);
  if (!keyA) throw new SyaiFailure('noCalibration', "Couldn't read your bound sensor: no 'keyA' (BLE key group)");
  if (produceTime === null) throw new SyaiFailure('noCalibration', "Couldn't read your bound sensor: no 'produceTime' for the keyA KDF");
  const activeExpireTime = num(body.activeExpireTime);
  const preheatPeriodTime = num(body.preheatPeriodTime);
  if (activeExpireTime === null) throw new SyaiFailure('noCalibration', "Couldn't read your bound sensor: no 'activeExpireTime'");
  if (preheatPeriodTime === null) throw new SyaiFailure('noCalibration', "Couldn't read your bound sensor: no 'preheatPeriodTime'");
  const coefficient = str(body.coefficient);
  const coeffUpdateTime = num(body.coeffUpdateTime);
  if (!coefficient || coeffUpdateTime === null) {
    throw new SyaiFailure('noCalibration', "Syai didn't provide this sensor's calibration, so it can't be used.");
  }
  const activeTime = num(body.activeTime);
  return {
    keyGroup: decipherKeyGroup(keyA, produceTime, mac, glucoseSecretKey),
    activatedAt: activeTime !== null && activeTime > 0 ? activeTime : null,
    deviceInfo: {
      mac,
      serialNo: str(body.serialNo) ?? '',
      batchNo: str(body.batchNo) ?? '',
      deviceType: str(body.deviceType) ?? '',
      deviceVersion: str(body.deviceVersion) ?? '',
      coefficients: decipherCoefficients(coefficient, coeffUpdateTime, mac, glucoseSecretKey),
      activeDurationSec: activeExpireTime / 1000,
      preheatDurationSec: preheatPeriodTime / 1000,
    },
  };
}

/** `authInfo`'s values win over the bound record's; an explicit null never erases a value. */
export function mergeBoundAndAuthInfo(bound: Readonly<Record<string, unknown>>, authInfoData: Readonly<Record<string, unknown>> | null): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...bound };
  for (const [k, v] of Object.entries(authInfoData ?? {})) if (v !== null && v !== undefined) merged[k] = v;
  return merged;
}

export const missingForAdoption = (body: Readonly<Record<string, unknown>>): boolean =>
  ['keyA', 'produceTime', 'activeExpireTime', 'preheatPeriodTime'].some((k) => body[k] === undefined || body[k] === null);
