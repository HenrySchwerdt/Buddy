/**
 * Persisted state of the Syai driver (ports the persisted subset of CGMManagerState.swift,
 * SyaiSensorStore.swift and SyaiKeychain.swift from SyaiKit, MIT, © 2026 Nightscout Foundation).
 *
 * Everything here lives in the keychain-backed `ctx.secrets`: the sensor record contains the BLE
 * key group, the account session contains tokens. Neither is ever logged.
 */
import { base64Decode, base64Encode } from './bytes';
import { KEY_GROUP_BYTES } from './ble-auth';
import { SYAI_ID } from './constants';
import type { SyaiFault } from './lifecycle';
import { COEFFICIENT_COUNT } from './rpn';
import type { BoundSensor, SyaiDeviceInfo } from './provisioning';
import type { SyaiAccount } from './cloud-client';

export const SYAI_STATE_KEY = `${SYAI_ID}.state`;
export const SYAI_ACCOUNT_KEY = `${SYAI_ID}.account`;

export interface SyaiSensorRecord {
  readonly deviceInfo: SyaiDeviceInfo;
  /** base64 of the 96 key-group bytes. */
  readonly keyGroup: string;
  readonly activatedAt: number | null;
  /** Peripheral id from the last connection (tried before scanning). */
  readonly peripheralId: string | null;
}

export interface SyaiState {
  readonly sensor: SyaiSensorRecord | null;
  /** Newest on-grid record held; the backfill watermark. */
  readonly lastGridSequence: number | null;
  readonly latestReadingTimestamp: number | null;
  /** The sensor's own elapsed field of the newest live record and when it arrived. */
  readonly latestElapsedSeconds: number | null;
  readonly latestElapsedReceivedAt: number | null;
  /** Terminal fault; cleared only by adopting another sensor. */
  readonly fault: SyaiFault | null;
}

export const EMPTY_SYAI_STATE: SyaiState = {
  sensor: null,
  lastGridSequence: null,
  latestReadingTimestamp: null,
  latestElapsedSeconds: null,
  latestElapsedReceivedAt: null,
  fault: null,
};

export const sensorRecordFrom = (bound: BoundSensor, peripheralId: string | null = null): SyaiSensorRecord => ({
  deviceInfo: bound.deviceInfo,
  keyGroup: base64Encode(bound.keyGroup),
  activatedAt: bound.activatedAt,
  peripheralId,
});

export const keyGroupBytes = (r: SyaiSensorRecord): Uint8Array | null => {
  const b = base64Decode(r.keyGroup);
  return b && b.length === KEY_GROUP_BYTES ? b : null;
};

export const serializeSyaiState = (s: SyaiState): string => JSON.stringify(s);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function parseFault(v: unknown): SyaiFault | null {
  const o = obj(v);
  if (!o) return null;
  if (o.kind === 'signalImplausible') return { kind: 'signalImplausible' };
  const state = num(o.state);
  if ((o.kind === 'deviceStateObsolete' || o.kind === 'deviceStateUnactivated') && state !== null) return { kind: o.kind, state };
  return null;
}

function parseSensor(v: unknown): SyaiSensorRecord | null {
  const o = obj(v);
  const info = obj(o?.deviceInfo);
  if (!o || !info) return null;
  const mac = str(info.mac);
  const coefficients = Array.isArray(info.coefficients) && info.coefficients.every((c) => typeof c === 'number' && Number.isFinite(c)) ? (info.coefficients as number[]) : null;
  const activeDurationSec = num(info.activeDurationSec);
  const preheatDurationSec = num(info.preheatDurationSec);
  const keyGroup = str(o.keyGroup);
  if (!mac || !coefficients || coefficients.length !== COEFFICIENT_COUNT || activeDurationSec === null || preheatDurationSec === null || !keyGroup) return null;
  return {
    keyGroup,
    activatedAt: num(o.activatedAt),
    peripheralId: str(o.peripheralId),
    deviceInfo: {
      mac,
      serialNo: str(info.serialNo) ?? '',
      batchNo: str(info.batchNo) ?? '',
      deviceType: str(info.deviceType) ?? '',
      deviceVersion: str(info.deviceVersion) ?? '',
      coefficients,
      activeDurationSec,
      preheatDurationSec,
    },
  };
}

/** Tolerant parse: anything corrupt falls back to the empty state (the sensor is re-fetched from the account). */
export function parseSyaiState(raw: string | null): SyaiState {
  if (!raw) return EMPTY_SYAI_STATE;
  try {
    const o = obj(JSON.parse(raw));
    if (!o) return EMPTY_SYAI_STATE;
    return {
      sensor: parseSensor(o.sensor),
      lastGridSequence: num(o.lastGridSequence),
      latestReadingTimestamp: num(o.latestReadingTimestamp),
      latestElapsedSeconds: num(o.latestElapsedSeconds),
      latestElapsedReceivedAt: num(o.latestElapsedReceivedAt),
      fault: parseFault(o.fault),
    };
  } catch {
    return EMPTY_SYAI_STATE;
  }
}

export const serializeAccount = (a: SyaiAccount): string => JSON.stringify(a);

export function parseAccount(raw: string | null): Omit<SyaiAccount, 'installDeviceId'> & { installDeviceId: string | null } {
  const empty = { refreshToken: '', accessToken: null, glucoseSecretKey: null, installDeviceId: null, email: null };
  if (!raw) return empty;
  try {
    const o = obj(JSON.parse(raw));
    if (!o) return empty;
    return { refreshToken: str(o.refreshToken) ?? '', accessToken: str(o.accessToken), glucoseSecretKey: str(o.glucoseSecretKey), installDeviceId: str(o.installDeviceId), email: str(o.email) };
  } catch {
    return empty;
  }
}
