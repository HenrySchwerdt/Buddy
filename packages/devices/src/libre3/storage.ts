/**
 * Persistence of the Libre 3 pairing state in Buddy's keychain-backed `SecretStore`. Replaces the
 * keychain / `rawState` persistence of LibreLoop (`LibreLoopKeychain.swift`,
 * `LibreLoopCGMManagerState.swift`) and RoundWhiteDiscKit `Libre3SensorStateLoader.swift`
 * (MIT, (c) the LibreLoop and RoundWhiteDiscKit authors).
 *
 * The cached authorization key (kAuth) is a secret: it is stored here only, never logged.
 */
import { fromHex, hex, type Bytes, type SecretStore } from '@buddy/core';
import { parseReceiverIdHex, receiverIdToHex } from './nfc';

export const LIBRE3_SECRET_KEYS = {
  sensor: 'libre3.sensor',
  receiverId: 'libre3.receiverId',
  appIdentities: 'libre3.appIdentities',
} as const;

export interface Libre3SensorState {
  readonly serialNumber: string;
  /** Display form, `CC:22:DF:B8:F9:58`; the sensor advertises it without separators as its name. */
  readonly bleAddress: string;
  /** 4-byte PIN from the last NFC activation / switch. */
  readonly blePin: Bytes;
  readonly receiverId: number;
  /** Phase 5 key cached by the last full handshake; null until the first pairing handshake completed. */
  readonly kAuth: Bytes | null;
  readonly appIdentity: string | null;
  /** Peripheral id found by the last scan (stable per phone); null forces a scan. */
  readonly peripheralId: string | null;
  readonly wearDurationMinutes: number | null;
  readonly warmupMinutes: number | null;
  readonly generation: number | null;
  readonly firmwareVersion: string | null;
  readonly pairedAt: number;
  /** Backfill watermark: newest sensor life count accepted so far. */
  readonly lastLifeCount: number | null;
  readonly needsReplacement: boolean;
  readonly endedNormally: boolean;
}

interface StoredState {
  serialNumber: string;
  bleAddress: string;
  blePin: string;
  receiverId: string;
  kAuth: string | null;
  appIdentity: string | null;
  peripheralId: string | null;
  wearDurationMinutes: number | null;
  warmupMinutes: number | null;
  generation: number | null;
  firmwareVersion: string | null;
  pairedAt: number;
  lastLifeCount: number | null;
  needsReplacement: boolean;
  endedNormally: boolean;
}

const isHex = (v: unknown, bytes: number): v is string => typeof v === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(v);
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function serializeSensorState(s: Libre3SensorState): string {
  const stored: StoredState = {
    serialNumber: s.serialNumber,
    bleAddress: s.bleAddress,
    blePin: hex(s.blePin),
    receiverId: receiverIdToHex(s.receiverId),
    kAuth: s.kAuth ? hex(s.kAuth) : null,
    appIdentity: s.appIdentity,
    peripheralId: s.peripheralId,
    wearDurationMinutes: s.wearDurationMinutes,
    warmupMinutes: s.warmupMinutes,
    generation: s.generation,
    firmwareVersion: s.firmwareVersion,
    pairedAt: s.pairedAt,
    lastLifeCount: s.lastLifeCount,
    needsReplacement: s.needsReplacement,
    endedNormally: s.endedNormally,
  };
  return JSON.stringify(stored);
}

export function parseSensorState(raw: string | null): Libre3SensorState | null {
  if (!raw) return null;
  let v: Partial<Record<keyof StoredState, unknown>>;
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    return null;
  }
  const receiverId = typeof v.receiverId === 'string' ? parseReceiverIdHex(v.receiverId) : null;
  if (typeof v.serialNumber !== 'string' || typeof v.bleAddress !== 'string' || !isHex(v.blePin, 4) || receiverId === null) return null;
  return {
    serialNumber: v.serialNumber,
    bleAddress: v.bleAddress,
    blePin: fromHex(v.blePin),
    receiverId,
    kAuth: isHex(v.kAuth, 16) ? fromHex(v.kAuth) : null,
    appIdentity: stringOrNull(v.appIdentity),
    peripheralId: stringOrNull(v.peripheralId),
    wearDurationMinutes: numberOrNull(v.wearDurationMinutes),
    warmupMinutes: numberOrNull(v.warmupMinutes),
    generation: numberOrNull(v.generation),
    firmwareVersion: stringOrNull(v.firmwareVersion),
    pairedAt: numberOrNull(v.pairedAt) ?? 0,
    lastLifeCount: numberOrNull(v.lastLifeCount),
    needsReplacement: v.needsReplacement === true,
    endedNormally: v.endedNormally === true,
  };
}

export const loadSensorState = async (secrets: SecretStore): Promise<Libre3SensorState | null> => parseSensorState(await secrets.get(LIBRE3_SECRET_KEYS.sensor));
export const saveSensorState = (secrets: SecretStore, state: Libre3SensorState): Promise<void> => secrets.set(LIBRE3_SECRET_KEYS.sensor, serializeSensorState(state));
export const clearSensorState = (secrets: SecretStore): Promise<void> => secrets.set(LIBRE3_SECRET_KEYS.sensor, null);

/** The app install's stable receiver id; generated once (any stable 4-byte value works) and kept, so re-scanning a sensor switches with the id it remembers. */
export async function loadOrCreateReceiverId(secrets: SecretStore, random: (n: number) => Bytes): Promise<number> {
  const existing = parseReceiverIdHex((await secrets.get(LIBRE3_SECRET_KEYS.receiverId)) ?? '');
  if (existing !== null) return existing;
  const bytes = random(4);
  const created = ((bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0) || 1;
  await secrets.set(LIBRE3_SECRET_KEYS.receiverId, receiverIdToHex(created));
  return created;
}
