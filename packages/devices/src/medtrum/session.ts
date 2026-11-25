/**
 * Persisted patch session of the Medtrum Nano driver — the subset of
 * `MedtrumKit/PumpManager/MedtrumPumpState.swift` (loopandlearn/MedtrumKit, MIT License,
 * (c) the original MedtrumKit authors) that a TypeScript driver needs, stored as JSON in the
 * app's keychain-backed `SecretStore`.
 */
import type { InsulinDose, Millis, Schedule, SecretStore } from '@buddy/core';
import { emptyLedger, type BasalSegment, type LedgerSnapshot, type PendingBolus, type PendingTempBasal } from './dose-ledger';
import { PatchState, parsePatchState } from './enums';

export type BasalState = 'active' | 'suspended' | 'tempBasal';

export interface PreviousPatch {
  readonly patchId: number | null;
  readonly lastState: PatchState;
  readonly lastSyncAt: Millis;
  readonly activatedAt: Millis | null;
  readonly deactivatedAt: Millis;
  readonly reservoirLevel: number | null;
}

export interface MedtrumSession {
  readonly version: 1;
  /** hex, 4 bytes, or '' when no patch session is running */
  readonly sessionToken: string;
  readonly backupSessionToken: string;
  /** null = no patch id known (`Data()` in Swift) */
  readonly patchId: number | null;
  readonly pumpState: PatchState;
  /** No patch session is running: the last one ended, or none started yet */
  readonly patchSessionEnded: boolean;
  readonly patchActivatedAt: Millis | null;
  readonly previousPatch: PreviousPatch | null;
  /** BLE id of the pump base (survives patch changes). */
  readonly deviceId: string | null;
  readonly lastSync: Millis;
  readonly reservoir: number | null;
  readonly initialReservoir: number | null;
  /** volts (voltageB) */
  readonly battery: number | null;
  /** basalState is the basalState from the patch itself */
  readonly basalState: BasalState;
  readonly basalSchedule: Schedule;
  readonly primeProgress: number;
  readonly deviceType: number;
  readonly swVersion: string;
  readonly pumpTime: Millis | null;
  readonly pumpTimeSyncedAt: Millis | null;
  readonly ledger: LedgerSnapshot;
}

export const initialSession = (): MedtrumSession => ({
  version: 1,
  sessionToken: '',
  backupSessionToken: '',
  patchId: null,
  pumpState: PatchState.none,
  patchSessionEnded: true,
  patchActivatedAt: null,
  previousPatch: null,
  deviceId: null,
  lastSync: 0,
  reservoir: null,
  initialReservoir: null,
  battery: null,
  basalState: 'active',
  basalSchedule: [],
  primeProgress: 0,
  deviceType: 0,
  swVersion: '0.0.0',
  pumpTime: null,
  pumpTimeSyncedAt: null,
  ledger: emptyLedger(),
});

export const sessionKey = (serialHex: string): string => `medtrum-nano/${serialHex.toUpperCase()}/session`;

// ── validation of the stored JSON (never trust storage blindly) ────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const hex4OrEmpty = (v: unknown): string => (typeof v === 'string' && /^([0-9a-f]{8})?$/i.test(v) ? v.toLowerCase() : '');

function parseDose(v: unknown): InsulinDose | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.date !== 'number') return null;
  switch (v.kind) {
    case 'bolus':
    case 'smb':
      return typeof v.units === 'number' && v.units > 0 ? { kind: v.kind, date: v.date, units: v.units, id: v.id } : null;
    case 'tempBasal':
      return typeof v.rate === 'number' && typeof v.durationMin === 'number'
        ? { kind: 'tempBasal', date: v.date, rate: v.rate, durationMin: v.durationMin, id: v.id }
        : null;
    case 'suspend':
      return typeof v.durationMin === 'number' ? { kind: 'suspend', date: v.date, durationMin: v.durationMin, id: v.id } : null;
    default:
      return null;
  }
}

function parseSegment(v: unknown): BasalSegment {
  if (!isObj(v) || typeof v.since !== 'number') return { kind: 'scheduled', since: 0 };
  if (v.kind === 'temp' && typeof v.doseId === 'string' && typeof v.rate === 'number' && typeof v.durationMin === 'number') {
    return { kind: 'temp', since: v.since, doseId: v.doseId, rate: v.rate, durationMin: v.durationMin, ...(v.openEnded === true ? { openEnded: true } : {}) };
  }
  if (v.kind === 'suspended' && typeof v.doseId === 'string') return { kind: 'suspended', since: v.since, doseId: v.doseId };
  return { kind: 'scheduled', since: v.since };
}

function parsePendingBolus(v: unknown): PendingBolus | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.requested !== 'number' || typeof v.sentAt !== 'number') return null;
  return {
    id: v.id,
    requested: v.requested,
    delivered: num(v.delivered, 0),
    automatic: v.automatic === true,
    sentAt: v.sentAt,
    confirmed: v.confirmed === true,
  };
}

function parsePendingTemp(v: unknown): PendingTempBasal | null {
  if (!isObj(v) || typeof v.rate !== 'number' || typeof v.durationMin !== 'number' || typeof v.sentAt !== 'number') return null;
  return { rate: v.rate, durationMin: v.durationMin, sentAt: v.sentAt };
}

function parseLedger(v: unknown): LedgerSnapshot {
  if (!isObj(v)) return emptyLedger();
  const doses = Array.isArray(v.doses) ? v.doses.map(parseDose).filter((d): d is InsulinDose => d !== null) : [];
  const u = v.uncertainBolus;
  const uncertainBolus = isObj(u) && typeof u.id === 'string' && typeof u.requested === 'number' ? { id: u.id, requested: u.requested } : null;
  return {
    doses,
    basal: parseSegment(v.basal),
    pendingBolus: parsePendingBolus(v.pendingBolus),
    pendingTempBasal: parsePendingTemp(v.pendingTempBasal),
    uncertainBolus,
  };
}

function parseSchedule(v: unknown): Schedule {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is { startMinute: number; value: number } => isObj(e) && typeof e.startMinute === 'number' && typeof e.value === 'number');
}

function parsePrevious(v: unknown): PreviousPatch | null {
  if (!isObj(v) || typeof v.deactivatedAt !== 'number') return null;
  return {
    patchId: numOrNull(v.patchId),
    lastState: parsePatchState(num(v.lastState, 0)),
    lastSyncAt: num(v.lastSyncAt, 0),
    activatedAt: numOrNull(v.activatedAt),
    deactivatedAt: v.deactivatedAt,
    reservoirLevel: numOrNull(v.reservoirLevel),
  };
}

export function parseSession(json: string): MedtrumSession {
  const v: unknown = JSON.parse(json);
  if (!isObj(v) || v.version !== 1) throw new Error('Unsupported Medtrum session format');
  const d = initialSession();
  const pumpState = parsePatchState(num(v.pumpState, d.pumpState));
  const basalState = v.basalState === 'suspended' || v.basalState === 'tempBasal' ? v.basalState : 'active';
  return {
    version: 1,
    sessionToken: hex4OrEmpty(v.sessionToken),
    backupSessionToken: hex4OrEmpty(v.backupSessionToken),
    patchId: numOrNull(v.patchId),
    pumpState,
    patchSessionEnded: typeof v.patchSessionEnded === 'boolean' ? v.patchSessionEnded : d.patchSessionEnded,
    patchActivatedAt: numOrNull(v.patchActivatedAt),
    previousPatch: parsePrevious(v.previousPatch),
    deviceId: typeof v.deviceId === 'string' ? v.deviceId : null,
    lastSync: num(v.lastSync, 0),
    reservoir: numOrNull(v.reservoir),
    initialReservoir: numOrNull(v.initialReservoir),
    battery: numOrNull(v.battery),
    basalState,
    basalSchedule: parseSchedule(v.basalSchedule),
    primeProgress: num(v.primeProgress, 0),
    deviceType: num(v.deviceType, 0),
    swVersion: str(v.swVersion, d.swVersion),
    pumpTime: numOrNull(v.pumpTime),
    pumpTimeSyncedAt: numOrNull(v.pumpTimeSyncedAt),
    ledger: parseLedger(v.ledger),
  };
}

export async function loadSession(secrets: SecretStore, key: string): Promise<MedtrumSession> {
  const raw = await secrets.get(key);
  return raw === null ? initialSession() : parseSession(raw);
}

export const saveSession = (secrets: SecretStore, key: string, s: MedtrumSession): Promise<void> => secrets.set(key, JSON.stringify(s));
