/**
 * The persisted pump record: what the driver knows about the pump between app runs (detected
 * model, tuned frequency, last readings, the dose ledger with a command of unknown outcome).
 * Condensed from `MinimedPumpManagerState.swift` and `PumpState.swift` of MinimedKit (migrated
 * from ps2/rileylink_ios, MIT License, (c) LoopKit Authors). Stored as JSON in the app's
 * keychain-backed `SecretStore`, one record per pump serial; it is never logged.
 */
import type { InsulinDose, Millis, Schedule, SecretStore } from '@buddy/core';
import { emptyLedger, type ActiveBolus, type BasalSegment, type LedgerState, type PendingCommand, type UnverifiedBolus } from './ledger';
import { isPumpModel, type PumpModel } from './models';

export interface MinimedRecord {
  readonly version: 1;
  /** detected from the pump */
  readonly pumpModel: PumpModel | null;
  /** last frequency the radio tune found, MHz */
  readonly frequencyMhz: number | null;
  readonly lastTuned: Millis;
  readonly lastSync: Millis;
  /** history events newer than this were imported already */
  readonly lastHistorySync: Millis;
  readonly reservoirUnits: number | null;
  readonly batteryPercent: number | null;
  readonly suspended: boolean;
  /** the pump is bolusing (also a bolus from its buttons) */
  readonly pumpBolusing: boolean;
  /** the pump runs a percent temp basal (Buddy cannot dose against it) */
  readonly percentTempBasal: boolean;
  /** pump limits, read from the pump's settings */
  readonly maxBolus: number | null;
  readonly maxBasal: number | null;
  /** the pump's standard basal profile (U/h) */
  readonly basalSchedule: Schedule;
  /** UTC offset (seconds) the pump clock is kept in */
  readonly utcOffsetSeconds: number;
  readonly ledger: LedgerState;
}

export const initialRecord = (): MinimedRecord => ({
  version: 1,
  pumpModel: null,
  frequencyMhz: null,
  lastTuned: 0,
  lastSync: 0,
  lastHistorySync: 0,
  reservoirUnits: null,
  batteryPercent: null,
  suspended: false,
  pumpBolusing: false,
  percentTempBasal: false,
  maxBolus: null,
  maxBasal: null,
  basalSchedule: [],
  utcOffsetSeconds: 0,
  ledger: emptyLedger(),
});

export const recordKey = (serial: string): string => `minimed/pump/${serial}`;

// ── validation of the stored JSON (never trust storage blindly) ────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseDose(v: unknown): InsulinDose | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.date !== 'number') return null;
  switch (v.kind) {
    case 'bolus':
    case 'smb':
      return typeof v.units === 'number' && v.units > 0 ? { kind: v.kind, date: v.date, units: v.units, id: v.id } : null;
    case 'tempBasal':
      return typeof v.rate === 'number' && typeof v.durationMin === 'number' ? { kind: 'tempBasal', date: v.date, rate: v.rate, durationMin: v.durationMin, id: v.id } : null;
    case 'suspend':
      return typeof v.durationMin === 'number' ? { kind: 'suspend', date: v.date, durationMin: v.durationMin, id: v.id } : null;
    default:
      return null;
  }
}

function parseSegment(v: unknown): BasalSegment {
  if (!isObj(v)) return { kind: 'scheduled' };
  if (v.kind === 'temp' && typeof v.doseId === 'string' && typeof v.rate === 'number' && typeof v.startedAt === 'number' && typeof v.durationMin === 'number') {
    return { kind: 'temp', doseId: v.doseId, rate: v.rate, startedAt: v.startedAt, durationMin: v.durationMin };
  }
  if (v.kind === 'suspended' && typeof v.doseId === 'string' && typeof v.since === 'number') return { kind: 'suspended', doseId: v.doseId, since: v.since };
  return { kind: 'scheduled' };
}

function parseBolus(v: unknown): ActiveBolus | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.requested !== 'number' || typeof v.sentAt !== 'number' || typeof v.durationMs !== 'number') return null;
  return { id: v.id, requested: v.requested, automatic: v.automatic === true, sentAt: v.sentAt, durationMs: v.durationMs };
}

function parsePending(v: unknown): PendingCommand | null {
  if (!isObj(v) || typeof v.sentAt !== 'number') return null;
  switch (v.kind) {
    case 'bolus':
      return typeof v.units === 'number' && typeof v.id === 'string' ? { kind: 'bolus', id: v.id, units: v.units, automatic: v.automatic === true, sentAt: v.sentAt } : null;
    case 'tempBasal':
      return typeof v.rate === 'number' && typeof v.durationMin === 'number'
        ? { kind: 'tempBasal', rate: v.rate, durationMin: v.durationMin, sentAt: v.sentAt, priorRate: numOrNull(v.priorRate), priorRemainingMin: num(v.priorRemainingMin, 0) }
        : null;
    case 'suspend':
      return { kind: 'suspend', sentAt: v.sentAt };
    case 'resume':
      return { kind: 'resume', sentAt: v.sentAt };
    default:
      return null;
  }
}

function parseUnverified(v: unknown): UnverifiedBolus | null {
  return isObj(v) && typeof v.id === 'string' && typeof v.requested === 'number' && typeof v.date === 'number' && typeof v.finishedAt === 'number'
    ? { id: v.id, requested: v.requested, date: v.date, finishedAt: v.finishedAt }
    : null;
}

function parseLedger(v: unknown): LedgerState {
  if (!isObj(v)) return emptyLedger();
  // Fail closed: a pending command or running bolus that is stored but unreadable must never be forgotten (it would unblock dosing).
  const pending = v.pending === undefined || v.pending === null ? null : parsePending(v.pending);
  if (v.pending !== undefined && v.pending !== null && pending === null) throw new Error('Unreadable pending command in the MiniMed record');
  const bolus = v.bolus === undefined || v.bolus === null ? null : parseBolus(v.bolus);
  if (v.bolus !== undefined && v.bolus !== null && bolus === null) throw new Error('Unreadable running bolus in the MiniMed record');
  return {
    doses: Array.isArray(v.doses) ? v.doses.map(parseDose).filter((d): d is InsulinDose => d !== null) : [],
    bolus,
    basal: parseSegment(v.basal),
    pending,
    unverified: Array.isArray(v.unverified) ? v.unverified.map(parseUnverified).filter((u): u is UnverifiedBolus => u !== null) : [],
  };
}

function parseSchedule(v: unknown): Schedule {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is { startMinute: number; value: number } => isObj(e) && typeof e.startMinute === 'number' && typeof e.value === 'number');
}

export function parseRecord(json: string): MinimedRecord {
  const v: unknown = JSON.parse(json);
  if (!isObj(v) || v.version !== 1) throw new Error('Unsupported MiniMed record format');
  return {
    version: 1,
    pumpModel: isPumpModel(v.pumpModel) ? v.pumpModel : null,
    frequencyMhz: numOrNull(v.frequencyMhz),
    lastTuned: num(v.lastTuned, 0),
    lastSync: num(v.lastSync, 0),
    lastHistorySync: num(v.lastHistorySync, 0),
    reservoirUnits: numOrNull(v.reservoirUnits),
    batteryPercent: numOrNull(v.batteryPercent),
    suspended: v.suspended === true,
    pumpBolusing: v.pumpBolusing === true,
    percentTempBasal: v.percentTempBasal === true,
    maxBolus: numOrNull(v.maxBolus),
    maxBasal: numOrNull(v.maxBasal),
    basalSchedule: parseSchedule(v.basalSchedule),
    utcOffsetSeconds: num(v.utcOffsetSeconds, 0),
    ledger: parseLedger(v.ledger),
  };
}

export async function loadRecord(secrets: SecretStore, serial: string): Promise<MinimedRecord> {
  const raw = await secrets.get(recordKey(serial));
  return raw === null ? initialRecord() : parseRecord(raw);
}

export const saveRecord = (secrets: SecretStore, serial: string, r: MinimedRecord): Promise<void> => secrets.set(recordKey(serial), JSON.stringify(r));
export const clearRecord = (secrets: SecretStore, serial: string): Promise<void> => secrets.set(recordKey(serial), null);
