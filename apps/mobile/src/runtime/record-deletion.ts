import { glucoseSource } from './record-ids';
import { now, runLoop, store } from './runtime';
import { deleteFromNightscout } from './services';
import { deleteFromHealth } from './health/health';
import { deleteFromTidepool } from './tidepool';
import type { HealthKind } from './health/samples';

export type RecordKind = HealthKind;

export interface ServiceOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

export interface DeletionReport {
  /** Whether the record existed locally and was removed. */
  readonly local: boolean;
  readonly nightscout: ServiceOutcome;
  readonly health: ServiceOutcome;
  readonly tidepool: ServiceOutcome;
}

/** Removes the record from the local store; returns whether it was there. */
function deleteLocally(kind: RecordKind, id: string, date: number): boolean {
  const snap = store.snapshot();
  switch (kind) {
    case 'carbs': {
      const found = snap.carbs.some((c) => c.id === id);
      store.removeCarbs(id);
      return found;
    }
    case 'insulin': {
      const found = snap.doses.some((d) => d.id === id);
      if (found) store.replace({ ...snap, doses: snap.doses.filter((d) => d.id !== id) });
      return found;
    }
    case 'glucose': {
      const source = glucoseSource(id, date);
      const found = snap.glucose.some((g) => g.source === source && g.date === date);
      store.removeGlucose(source, date);
      return found;
    }
  }
}

const guard = async (task: () => Promise<ServiceOutcome>): Promise<ServiceOutcome> => {
  try {
    return await task();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * Trio's delete flow for glucose, carbs and insulin: removes the record locally, then from Nightscout (upload on),
 * Apple Health / Health Connect (integration on) and Tidepool (upload on). Never throws; a failing service is reported in the result
 * and does not stop the others. Services that are switched off report ok.
 *
 * Both functions take: `kind`: 'glucose' | 'carbs' | 'insulin'
 * - `id`: the carb entry id or dose id; for glucose the reading's `source` (or the full `<source>-<date>` identifier)
 * - `date`: epoch ms of the record (required for glucose, ignored otherwise)
 *
 * Doses a pump driver re-reports from its history may reappear locally on the next pump sync.
 */
export async function deleteRecordWithReport(kind: RecordKind, id: string, date: number): Promise<DeletionReport> {
  const local = deleteLocally(kind, id, date);
  const clock = () => now();
  const nsTarget = kind === 'glucose' ? ({ kind, id: `${glucoseSource(id, date)}-${Math.round(date)}`, date } as const) : ({ kind, id } as const);
  const [nightscout, health, tidepool] = await Promise.all([
    guard(() => deleteFromNightscout(clock, nsTarget)),
    guard(() => deleteFromHealth(kind, id, date)),
    guard(() => deleteFromTidepool(kind, id, date)),
  ]);
  // IOB and COB changed: recalculate (Trio runs determineBasal after a deletion).
  void runLoop();
  return { local, nightscout, health, tidepool };
}

/** Same as `deleteRecordWithReport` for callers that do not show per-service results; failures are logged (no record contents). */
export async function deleteRecordEverywhere(kind: RecordKind, id: string, date: number): Promise<void> {
  const report = await deleteRecordWithReport(kind, id, date);
  for (const [service, outcome] of Object.entries({ nightscout: report.nightscout, health: report.health, tidepool: report.tidepool })) {
    if (!outcome.ok) console.warn(`[buddy] Deleting a ${kind} record from ${service} failed: ${outcome.error ?? 'unknown error'}`);
  }
}
