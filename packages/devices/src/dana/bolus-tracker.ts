/**
 * Bolus bookkeeping for the Dana driver. Ports the delivery-tracking parts of
 * DanaKit/PumpManager/DanaKitPumpManager.swift (`notifyBolusDidUpdate`, `notifyBolusDone`,
 * `notifyBolusError`, `checkBolusDone`) and the bolus part of `syncHistory` in
 * DanaKitPumpManager+History.swift, from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and
 * the DanaKit authors).
 *
 * Deliberate deviations (Buddy's PumpDriver contract: history() lists only DELIVERED insulin):
 * - `checkBolusDone` (link lost mid-bolus) assumes the whole bolus was delivered. Buddy marks the
 *   bolus *uncertain* and reconciles it from the pump's own bolus history after reconnecting.
 * - `notifyBolusError` (alarm during a bolus) drops the dose. Buddy reconciles it from history too.
 *
 * Matching pump history records to boluses: the pump cannot run two boluses at once, so a record
 * belongs to one of our boluses when its (pump-clock) timestamp lies inside that bolus' run time
 * ± `MATCH_SKEW_MS` and its value does not exceed the requested amount. Our boluses are kept as
 * persisted fingerprints, so their records are never imported a second time, also after a restart.
 */
import type { InsulinDose, Millis } from '@buddy/core';
import { HistoryCode, type HistoryItem } from './packets/history';

/** Allowed difference between the bolus run time and the pump's record timestamp (after clock-offset correction). */
export const MATCH_SKEW_MS = 2 * 60_000;
/** After the expected end, how long a missing history record is still put down to a slow pump. */
export const UNCERTAIN_GRACE_MS = 2 * 60_000;
/** Without a DELIVERY_COMPLETE notification this long after the expected end, the bolus is uncertain. */
export const COMPLETION_OVERDUE_MS = 60_000;
/** Own-bolus fingerprints are kept this long (history uploads never reach further back in practice). */
export const FINGERPRINT_RETENTION_MS = 48 * 3_600_000;
/** Slack when comparing a history value against the requested amount (pump rounding). */
const VALUE_SLACK = 0.05;

export type BolusPhase = 'starting' | 'running' | 'uncertain';

export interface PendingBolus {
  readonly id: string;
  readonly requested: number;
  readonly automatic: boolean;
  readonly startedAt: Millis;
  /** Expected end of delivery; moved to the stop time once a stop was accepted. */
  expectedEnd: Millis;
  phase: BolusPhase;
  /** Last delivered amount the pump reported (DELIVERY_RATE_DISPLAY), U. */
  delivered: number;
  /** `lastReportedBolusStep` — whole units for which a keep-alive was sent. */
  lastReportedStep: number;
}

/** A bolus this driver started (phone clock), persisted so its pump record is recognised later. */
export interface BolusFingerprint {
  readonly id: string;
  readonly start: Millis;
  readonly end: Millis;
  readonly requested: number;
  /** Id of the pump history record already attributed to it. */
  readonly recordId?: string;
}

export const historyRecordId = (deviceName: string, item: HistoryItem): string =>
  `dana-${deviceName}-hist-${Array.from(item.raw, (b) => b.toString(16).padStart(2, '0')).join('')}`;

export const bolusDose = (b: PendingBolus, units: number): InsulinDose => ({
  kind: b.automatic ? 'smb' : 'bolus',
  id: b.id,
  date: b.startedAt,
  units: Math.round(units * 100) / 100,
});

export const fingerprintOf = (b: PendingBolus): BolusFingerprint => ({ id: b.id, start: b.startedAt, end: b.expectedEnd, requested: b.requested });

/** Distance of a record (pump clock) from a bolus run time (phone clock + offset); null when outside the window. */
function distance(r: HistoryItem, f: BolusFingerprint, pumpClockOffset: number): number | null {
  if (r.code !== HistoryCode.RECORD_TYPE_BOLUS || r.value === undefined || r.value > f.requested + VALUE_SLACK) return null;
  const start = f.start + pumpClockOffset;
  const end = f.end + pumpClockOffset;
  if (r.timestamp < start - MATCH_SKEW_MS || r.timestamp > end + MATCH_SKEW_MS) return null;
  return Math.abs(r.timestamp - start);
}

/**
 * Attributes bolus records to our boluses, nearest first, one record per bolus. Returns the new
 * attributions (fingerprint id → record) for fingerprints that had none yet.
 */
export function attributeRecords(
  records: readonly HistoryItem[],
  fingerprints: readonly BolusFingerprint[],
  pumpClockOffset: number,
  idOf: (r: HistoryItem) => string,
): Map<string, HistoryItem> {
  const takenRecords = new Set(fingerprints.flatMap((f) => (f.recordId ? [f.recordId] : [])));
  const pairs: { f: BolusFingerprint; r: HistoryItem; d: number }[] = [];
  for (const f of fingerprints) {
    if (f.recordId) continue;
    for (const r of records) {
      if (takenRecords.has(idOf(r))) continue;
      const d = distance(r, f, pumpClockOffset);
      if (d !== null) pairs.push({ f, r, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);

  const result = new Map<string, HistoryItem>();
  for (const { f, r } of pairs) {
    if (result.has(f.id) || takenRecords.has(idOf(r))) continue;
    result.set(f.id, r);
    takenRecords.add(idOf(r));
  }
  return result;
}
