/**
 * Persistent driver state (the `InsightPumpManagerState` of InsightKit that matters for dosing):
 * the unresolved command record, the bolus / temp basal being tracked, the dose ledger and the
 * history cursor. It lives in Buddy's `SecretStore`, keyed by bridge id. The pairing key is NOT
 * part of it (see credentials.ts). Everything read back is validated: stored data is never trusted.
 */
import type { InsulinDose, Logger, SecretStore } from '@buddy/core';
import { asArray, asBool, asInt, asNumber, asString, isObject } from './models';

export type PendingKind = 'bolus' | 'setTBR' | 'cancelTBR' | 'suspend' | 'resume';

/** A dosing command that was (or may have been) sent. While one is unresolved no insulin is added. */
export interface PendingCommand {
  readonly kind: PendingKind;
  readonly requestId: string;
  readonly sentAt: number;
  /** History sequence at the time of sending: anything newer may belong to this command. */
  readonly baselineSequence: number | null;
  readonly units?: number;
  readonly percent?: number;
  readonly durationMin?: number;
  /** Scheduled basal rate the TBR percentage applies to. */
  readonly scheduledRate?: number;
  readonly automatic: boolean;
  /** False while the command is in flight in this process, true once timed out / link lost / app restarted. */
  readonly isUncertain: boolean;
  /** The history already delivered the dose of this (uncertain) command: do not also assume it was given. */
  readonly historyMatched?: boolean;
  /** The stored record could not be read: only the user can settle it (nothing can prove what it was). */
  readonly unreadable?: boolean;
}

/** A bolus the pump accepted and that may still be running. */
export interface TrackedBolus {
  readonly requestId: string;
  /** Programmed amount confirmed by the bridge. */
  readonly units: number;
  readonly bolusId: number | null;
  readonly sentAt: number;
  readonly acceptedAt: number;
  readonly automatic: boolean;
  /** Best evidence of what was delivered so far; never above `units`. */
  readonly delivered: number;
  /** Consecutive status reads (taken after `acceptedAt`) that did not list this bolus. */
  readonly missCount: number;
  /** The pump confirmed that this bolus was cancelled: it cannot be running any more. */
  readonly stopped: boolean;
}

/** A temp basal the pump accepted. */
export interface ActiveTemp {
  readonly requestId: string;
  readonly percent: number;
  readonly startedAt: number;
  readonly durationMin: number;
  /** Ledger dose ids of its constant-rate segments, in order. */
  readonly segmentIds: readonly string[];
}

export interface SuspendRecord {
  readonly doseId: string;
  readonly since: number;
}

/** A bolus whose dose is already in the ledger; `final` once the pump history confirmed its delivered amount. */
export interface KnownBolus {
  readonly bolusId: number;
  readonly doseId: string;
  readonly final: boolean;
}

export interface InsightPersisted {
  readonly version: 1;
  /** Last peripheral id that authenticated as the paired bridge (the address rotates). */
  readonly peripheralId: string | null;
  readonly pumpSerial: string | null;
  readonly lastHistorySequence: number | null;
  readonly lastHistoryRead: number | null;
  readonly pending: PendingCommand | null;
  readonly bolus: TrackedBolus | null;
  readonly temp: ActiveTemp | null;
  readonly suspended: SuspendRecord | null;
  readonly knownBoluses: readonly KnownBolus[];
  /** Dose ids of temp basals taken from the pump history (never imported twice). */
  readonly knownTemps: readonly string[];
  readonly doses: readonly InsulinDose[];
  /** Key of the basal profile that was written to the pump and read back; `null` = not confirmed. */
  readonly profileKey: string | null;
  readonly lastTimeSync: number | null;
}

export const emptyPersisted = (): InsightPersisted => ({
  version: 1,
  peripheralId: null,
  pumpSerial: null,
  lastHistorySequence: null,
  lastHistoryRead: null,
  pending: null,
  bolus: null,
  temp: null,
  suspended: null,
  knownBoluses: [],
  knownTemps: [],
  doses: [],
  profileKey: null,
  lastTimeSync: null,
});

export const stateKey = (bridgeId: string): string => `insight:state:${bridgeId.toLowerCase()}`;

const KINDS: ReadonlySet<string> = new Set(['bolus', 'setTBR', 'cancelTBR', 'suspend', 'resume']);

/** Stand-in for a stored command record that is present but cannot be read: it must keep blocking insulin. */
const unreadablePending = (): PendingCommand => ({ kind: 'bolus', requestId: 'unreadable-record', sentAt: 0, baselineSequence: null, automatic: false, isUncertain: true, unreadable: true });

function parsePending(v: unknown): PendingCommand | null {
  if (v === undefined || v === null) return null;
  if (!isObject(v)) return unreadablePending();
  const kind = asString(v.kind);
  const requestId = asString(v.requestId);
  const sentAt = asNumber(v.sentAt);
  if (kind === null || !KINDS.has(kind) || requestId === null || sentAt === null) return unreadablePending();
  const opt = <K extends string>(key: K, n: number | null) => (n === null ? {} : ({ [key]: n } as Record<K, number>));
  return {
    kind: kind as PendingKind,
    requestId,
    sentAt,
    baselineSequence: asInt(v.baselineSequence),
    ...opt('units', asNumber(v.units)),
    ...opt('percent', asNumber(v.percent)),
    ...opt('durationMin', asNumber(v.durationMin)),
    ...opt('scheduledRate', asNumber(v.scheduledRate)),
    automatic: asBool(v.automatic) ?? false,
    // A command that was in flight when the app died has an unknown outcome.
    isUncertain: true,
    ...(asBool(v.historyMatched) ? { historyMatched: true } : {}),
    ...(asBool(v.unreadable) ? { unreadable: true } : {}),
  };
}

function parseBolus(v: unknown): TrackedBolus | null {
  if (!isObject(v)) return null;
  const requestId = asString(v.requestId);
  const units = asNumber(v.units);
  const sentAt = asNumber(v.sentAt);
  const acceptedAt = asNumber(v.acceptedAt);
  const delivered = asNumber(v.delivered);
  if (requestId === null || units === null || sentAt === null || acceptedAt === null || delivered === null || units <= 0) return null;
  return {
    requestId,
    units,
    bolusId: asInt(v.bolusId),
    sentAt,
    acceptedAt,
    automatic: asBool(v.automatic) ?? false,
    delivered: Math.min(Math.max(delivered, 0), units),
    missCount: asInt(v.missCount) ?? 0,
    stopped: asBool(v.stopped) ?? false,
  };
}

function parseTemp(v: unknown): ActiveTemp | null {
  if (!isObject(v)) return null;
  const requestId = asString(v.requestId);
  const percent = asNumber(v.percent);
  const startedAt = asNumber(v.startedAt);
  const durationMin = asNumber(v.durationMin);
  const ids = asArray(v.segmentIds)?.filter((x): x is string => typeof x === 'string');
  if (requestId === null || percent === null || startedAt === null || durationMin === null || !ids || ids.length === 0) return null;
  return { requestId, percent, startedAt, durationMin, segmentIds: ids };
}

function parseDose(v: unknown): InsulinDose | null {
  if (!isObject(v)) return null;
  const id = asString(v.id);
  const date = asNumber(v.date);
  if (id === null || date === null) return null;
  switch (v.kind) {
    case 'bolus':
    case 'smb': {
      const units = asNumber(v.units);
      return units === null || units < 0 ? null : { kind: v.kind, id, date, units };
    }
    case 'tempBasal': {
      const rate = asNumber(v.rate);
      const durationMin = asNumber(v.durationMin);
      return rate === null || durationMin === null || rate < 0 || durationMin < 0 ? null : { kind: 'tempBasal', id, date, rate, durationMin };
    }
    case 'suspend': {
      const durationMin = asNumber(v.durationMin);
      return durationMin === null || durationMin < 0 ? null : { kind: 'suspend', id, date, durationMin };
    }
    default:
      return null;
  }
}

/** Validates everything read back from storage; garbage becomes an empty state. */
export function parsePersisted(raw: string | null): InsightPersisted {
  if (!raw) return emptyPersisted();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return emptyPersisted();
  }
  if (!isObject(v) || v.version !== 1) return emptyPersisted();
  const suspended = isObject(v.suspended) && asString(v.suspended.doseId) !== null && asNumber(v.suspended.since) !== null ? { doseId: asString(v.suspended.doseId)!, since: asNumber(v.suspended.since)! } : null;
  return {
    version: 1,
    peripheralId: asString(v.peripheralId),
    pumpSerial: asString(v.pumpSerial),
    lastHistorySequence: asInt(v.lastHistorySequence),
    lastHistoryRead: asNumber(v.lastHistoryRead),
    pending: parsePending(v.pending),
    bolus: parseBolus(v.bolus),
    temp: parseTemp(v.temp),
    suspended,
    knownBoluses: (asArray(v.knownBoluses) ?? []).flatMap((k) => {
      if (!isObject(k)) return [];
      const bolusId = asInt(k.bolusId);
      const doseId = asString(k.doseId);
      return bolusId === null || doseId === null ? [] : [{ bolusId, doseId, final: asBool(k.final) ?? false }];
    }),
    knownTemps: (asArray(v.knownTemps) ?? []).filter((x): x is string => typeof x === 'string'),
    doses: (asArray(v.doses) ?? []).flatMap((d) => {
      const dose = parseDose(d);
      return dose ? [dose] : [];
    }),
    profileKey: asString(v.profileKey),
    lastTimeSync: asNumber(v.lastTimeSync),
  };
}

/** Keeps the persisted blob bounded (it lives in a keychain entry). */
export const DOSE_RETENTION_MS = 24 * 3_600_000;
export const MAX_PERSISTED_DOSES = 300;

export class InsightStateStore {
  private cache: InsightPersisted | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly key: string,
    private readonly log: Logger,
  ) {}

  async load(): Promise<InsightPersisted> {
    if (!this.cache) {
      const raw = await this.secrets.get(this.key);
      this.cache = parsePersisted(raw);
    }
    return this.cache;
  }

  /** The state as of the last load / commit (call `load()` first). */
  get current(): InsightPersisted {
    return this.cache ?? emptyPersisted();
  }

  /**
   * Replaces the state in memory and writes it. Rejects when the write failed: the dosing path must
   * not send a command whose pending record could not be persisted. The in-memory state is updated
   * either way so it never diverges from what the driver believes.
   */
  async commit(next: InsightPersisted): Promise<void> {
    this.cache = next;
    const blob = JSON.stringify(next);
    try {
      await this.secrets.set(this.key, blob);
    } catch (e) {
      this.log.error(`Insight: could not persist the pump state: ${e instanceof Error ? e.name : 'error'}`);
      throw new Error('Insight: the pump state could not be stored');
    }
  }

  /** Updates the state in memory only (high-frequency progress that is re-derived from the pump after a restart). */
  setMemory(next: InsightPersisted): void {
    this.cache = next;
  }

  async modify(fn: (s: InsightPersisted) => InsightPersisted): Promise<void> {
    await this.load();
    await this.commit(fn(this.current));
  }

  async clear(): Promise<void> {
    this.cache = emptyPersisted();
    await this.secrets.set(this.key, null);
  }
}
