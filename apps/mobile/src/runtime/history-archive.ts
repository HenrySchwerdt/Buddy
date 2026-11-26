import type { CarbEntry, DataSnapshot, GlucoseReading, InsulinDose, Millis } from '@buddy/core';

/**
 * Long history (Trio keeps months): the app keeps `KEEP_HISTORY_MS` of glucose, doses and carbs in the store.
 * Persisting all of it in one JSON value on every change would be far too heavy, so the last day is stored as before and the
 * long history is stored in one small value per UTC day, rewritten only when that day changed.
 */

export const DAY_MS = 24 * 3_600_000;
/** How long glucose, insulin and carb history is kept (Stats shows up to 90 days). */
export const KEEP_HISTORY_MS = 90 * DAY_MS;
/** The recent part restored first (and written on every change), as before. */
export const RECENT_MS = 26 * 3_600_000;

export const dayOf = (t: Millis): number => Math.floor(t / DAY_MS);
export const archiveKey = (day: number): string => `buddy.history.v1.${day}`;
export const ARCHIVE_PREFIX = 'buddy.history.v1.';

export interface DayChunk {
  readonly glucose: readonly GlucoseReading[];
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly CarbEntry[];
}

/** Groups the history by UTC day, dropping everything older than `now - KEEP_HISTORY_MS`. Loop runs are not archived. */
export function groupByDay(snap: Pick<DataSnapshot, 'glucose' | 'doses' | 'carbs'>, now: Millis): Map<number, DayChunk> {
  const first = dayOf(now - KEEP_HISTORY_MS);
  const days = new Map<number, { glucose: GlucoseReading[]; doses: InsulinDose[]; carbs: CarbEntry[] }>();
  const bucket = (t: Millis) => {
    const d = dayOf(t);
    if (d < first || !Number.isFinite(d)) return null;
    let b = days.get(d);
    if (!b) days.set(d, (b = { glucose: [], doses: [], carbs: [] }));
    return b;
  };
  for (const g of snap.glucose) bucket(g.date)?.glucose.push(g);
  for (const d of snap.doses) bucket(d.date)?.doses.push(d);
  for (const c of snap.carbs) bucket(c.date)?.carbs.push(c);
  return days;
}

/** Cheap change detector for a day: counts and the newest timestamps. A deleted or corrected record changes it. */
export function chunkSignature(c: DayChunk): string {
  const last = (xs: readonly { date: Millis }[]) => xs.reduce((m, x) => Math.max(m, x.date), 0);
  const sumUnits = c.doses.reduce((s, d) => s + ('units' in d ? d.units : 'rate' in d ? d.rate + d.durationMin : d.durationMin), 0);
  return `${c.glucose.length}:${last(c.glucose)}:${c.doses.length}:${last(c.doses)}:${Math.round(sumUnits * 1000)}:${c.carbs.length}:${last(c.carbs)}:${Math.round(c.carbs.reduce((s, x) => s + x.grams, 0) * 10)}`;
}

const dedupe = <T>(items: readonly T[], key: (t: T) => string, date: (t: T) => number): T[] => {
  const byKey = new Map<string, T>();
  for (const i of items) byKey.set(key(i), i); // later items win
  return [...byKey.values()].sort((a, b) => date(a) - date(b));
};

/** Merges archived days into the recent snapshot (the recent copy wins on equal keys). */
export function mergeHistory(recent: DataSnapshot, chunks: readonly DayChunk[]): DataSnapshot {
  if (chunks.length === 0) return recent;
  return {
    ...recent,
    glucose: dedupe([...chunks.flatMap((c) => c.glucose), ...recent.glucose], (g) => `${g.source}:${g.date}`, (g) => g.date),
    doses: dedupe([...chunks.flatMap((c) => c.doses), ...recent.doses], (d) => d.id, (d) => d.date),
    carbs: dedupe([...chunks.flatMap((c) => c.carbs), ...recent.carbs], (c) => c.id, (c) => c.date),
  };
}

/** The part of the history kept in the main value: the last `RECENT_MS`, loop runs capped like before. */
export function recentPart(snap: DataSnapshot, now: Millis, maxLoopRuns = 100): DataSnapshot {
  const cutoff = now - RECENT_MS;
  return {
    glucose: snap.glucose.filter((g) => g.date >= cutoff),
    doses: snap.doses.filter((d) => d.date >= cutoff),
    carbs: snap.carbs.filter((c) => c.date >= cutoff),
    loopRuns: snap.loopRuns.filter((r) => r.date >= cutoff).slice(-maxLoopRuns),
  };
}

export interface ArchivePlan {
  /** Days to write, with their content. */
  readonly write: ReadonlyMap<number, DayChunk>;
  /** Days that no longer have data (or fell out of the window) and must be removed. */
  readonly remove: readonly number[];
  /** Signatures after the plan is applied. */
  readonly signatures: ReadonlyMap<number, string>;
}

/** What to write and delete so the stored days match `snap`, given the signatures that are already stored. */
export function planArchive(snap: DataSnapshot, now: Millis, stored: ReadonlyMap<number, string>): ArchivePlan {
  const days = groupByDay(snap, now);
  const write = new Map<number, DayChunk>();
  const signatures = new Map<number, string>();
  for (const [day, chunk] of days) {
    const sig = chunkSignature(chunk);
    signatures.set(day, sig);
    if (stored.get(day) !== sig) write.set(day, chunk);
  }
  const remove = [...stored.keys()].filter((d) => !days.has(d));
  return { write, remove, signatures };
}
