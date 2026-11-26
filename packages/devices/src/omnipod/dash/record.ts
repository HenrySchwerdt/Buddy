/**
 * The persisted pod record: pairing keys, ids, transport counters, setup progress, last status,
 * dose ledger. Stored as JSON in the app's keychain-backed `SecretStore` (it holds the LTK, so
 * it is never logged). Condensed from `PumpManager/PodState.swift` and `OmniPumpManagerState.swift`
 * of OmnipodKit (MIT License, (c) LoopKit Authors).
 */
import type { InsulinDose, Millis, Schedule, SecretStore } from '@buddy/core';
import { SetupProgress, type PodFault, type PodStatusSnapshot } from '../common';
import { emptyLedger, type ActiveBolus, type BasalSegment, type LedgerState } from './dose-ledger';
import type { PendingCommand } from './pending';
import { initialTransportState, type TransportState } from './transport';

export interface DashPodRecord {
  readonly version: 1;
  /** hex, 16 bytes. SECRET. null until pairing finished. */
  readonly ltk: string | null;
  readonly controllerId: number;
  readonly podId: number;
  /** BLE peripheral id of the pod */
  readonly bleId: string | null;
  readonly lot: number;
  readonly tid: number;
  readonly firmwareVersion: string;
  readonly iFirmwareVersion: string;
  readonly podModel: number;
  readonly transport: TransportState;
  readonly setupProgress: SetupProgress;
  readonly activatedAt: Millis | null;
  readonly primeFinishAt: Millis | null;
  readonly lastStatus: PodStatusSnapshot | null;
  readonly fault: PodFault | null;
  /** basal schedule programmed into the pod (U/h) */
  readonly basalSchedule: Schedule;
  /** UTC offset (seconds) the schedule was programmed with */
  readonly utcOffsetSeconds: number;
  /** total insulin delivered when setup completed (priming and cannula insertion are not dosing) */
  readonly setupUnitsDelivered: number | null;
  readonly lastSync: Millis;
  readonly ledger: LedgerState;
}

export const initialRecord = (): DashPodRecord => ({
  version: 1,
  ltk: null,
  controllerId: 0,
  podId: 0,
  bleId: null,
  lot: 0,
  tid: 0,
  firmwareVersion: '',
  iFirmwareVersion: '',
  podModel: 0,
  transport: initialTransportState(),
  setupProgress: SetupProgress.none,
  activatedAt: null,
  primeFinishAt: null,
  lastStatus: null,
  fault: null,
  basalSchedule: [],
  utcOffsetSeconds: 0,
  setupUnitsDelivered: null,
  lastSync: 0,
  ledger: emptyLedger(),
});

export const RECORD_KEY = 'omnipod-dash/pod';

// ── validation of the stored JSON (never trust storage blindly) ────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const hexOrNull = (v: unknown, bytes: number): string | null => (typeof v === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(v) ? v.toLowerCase() : null);

const SETUP_VALUES = new Set<string>(Object.values(SetupProgress));

function parseTransport(v: unknown): TransportState {
  const d = initialTransportState();
  if (!isObj(v)) return d;
  return {
    ck: hexOrNull(v.ck, 16),
    noncePrefix: hexOrNull(v.noncePrefix, 8),
    eapSeq: num(v.eapSeq, d.eapSeq),
    msgSeq: num(v.msgSeq, d.msgSeq) & 0xff,
    nonceSeq: num(v.nonceSeq, d.nonceSeq),
    messageNumber: num(v.messageNumber, d.messageNumber) & 0xf,
  };
}

function parseStatus(v: unknown): PodStatusSnapshot | null {
  if (!isObj(v) || typeof v.receivedAt !== 'number') return null;
  return {
    receivedAt: v.receivedAt,
    deliveryStatus: num(v.deliveryStatus, 1) as PodStatusSnapshot['deliveryStatus'],
    podProgress: num(v.podProgress, 0) as PodStatusSnapshot['podProgress'],
    timeActive: num(v.timeActive, 0),
    reservoirLevel: num(v.reservoirLevel, 0),
    insulinDelivered: num(v.insulinDelivered, 0),
    bolusNotDelivered: num(v.bolusNotDelivered, 0),
    lastProgrammingMessageSeqNum: num(v.lastProgrammingMessageSeqNum, 0),
    alerts: num(v.alerts, 0),
  };
}

function parseFault(v: unknown): PodFault | null {
  if (!isObj(v) || typeof v.code !== 'number') return null;
  return {
    code: v.code,
    description: str(v.description, 'Pod fault'),
    podProgress: num(v.podProgress, 13) as PodFault['podProgress'],
    timeSinceActivation: numOrNull(v.timeSinceActivation),
    totalInsulinDelivered: num(v.totalInsulinDelivered, 0),
    bolusNotDelivered: num(v.bolusNotDelivered, 0),
  };
}

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
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.requested !== 'number' || typeof v.sentAt !== 'number') return null;
  return { id: v.id, requested: v.requested, delivered: num(v.delivered, 0), automatic: v.automatic === true, sentAt: v.sentAt };
}

function parsePending(v: unknown): PendingCommand | null {
  if (!isObj(v) || typeof v.messageNumber !== 'number' || typeof v.sentAt !== 'number') return null;
  const base = { messageNumber: v.messageNumber & 0xf, sentAt: v.sentAt, priorProgSeq: numOrNull(v.priorProgSeq) };
  switch (v.kind) {
    case 'bolus':
      return typeof v.units === 'number' && typeof v.id === 'string' ? { kind: 'bolus', ...base, units: v.units, automatic: v.automatic === true, id: v.id } : null;
    case 'tempBasal':
      return typeof v.rate === 'number' && typeof v.durationMin === 'number' ? { kind: 'tempBasal', ...base, rate: v.rate, durationMin: v.durationMin } : null;
    case 'cancel':
      return { kind: 'cancel', ...base, deliveryType: num(v.deliveryType, 7) };
    case 'basalProgram':
      return { kind: 'basalProgram', ...base };
    default:
      return null;
  }
}

function parseLedger(v: unknown): LedgerState {
  if (!isObj(v)) return emptyLedger();
  return {
    doses: Array.isArray(v.doses) ? v.doses.map(parseDose).filter((d): d is InsulinDose => d !== null) : [],
    bolus: parseBolus(v.bolus),
    basal: parseSegment(v.basal),
    pending: parsePending(v.pending),
  };
}

function parseSchedule(v: unknown): Schedule {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is { startMinute: number; value: number } => isObj(e) && typeof e.startMinute === 'number' && typeof e.value === 'number');
}

export function parseRecord(json: string): DashPodRecord {
  const v: unknown = JSON.parse(json);
  if (!isObj(v) || v.version !== 1) throw new Error('Unsupported Omnipod DASH record format');
  const d = initialRecord();
  const setup = typeof v.setupProgress === 'string' && SETUP_VALUES.has(v.setupProgress) ? (v.setupProgress as SetupProgress) : d.setupProgress;
  return {
    version: 1,
    ltk: hexOrNull(v.ltk, 16),
    controllerId: num(v.controllerId, 0) >>> 0,
    podId: num(v.podId, 0) >>> 0,
    bleId: typeof v.bleId === 'string' ? v.bleId : null,
    lot: num(v.lot, 0),
    tid: num(v.tid, 0),
    firmwareVersion: str(v.firmwareVersion, ''),
    iFirmwareVersion: str(v.iFirmwareVersion, ''),
    podModel: num(v.podModel, 0),
    transport: parseTransport(v.transport),
    setupProgress: setup,
    activatedAt: numOrNull(v.activatedAt),
    primeFinishAt: numOrNull(v.primeFinishAt),
    lastStatus: parseStatus(v.lastStatus),
    fault: parseFault(v.fault),
    basalSchedule: parseSchedule(v.basalSchedule),
    utcOffsetSeconds: num(v.utcOffsetSeconds, 0),
    setupUnitsDelivered: numOrNull(v.setupUnitsDelivered),
    lastSync: num(v.lastSync, 0),
    ledger: parseLedger(v.ledger),
  };
}

export async function loadRecord(secrets: SecretStore): Promise<DashPodRecord> {
  const raw = await secrets.get(RECORD_KEY);
  return raw === null ? initialRecord() : parseRecord(raw);
}

export const saveRecord = (secrets: SecretStore, r: DashPodRecord): Promise<void> => secrets.set(RECORD_KEY, JSON.stringify(r));
export const clearRecord = (secrets: SecretStore): Promise<void> => secrets.set(RECORD_KEY, null);
