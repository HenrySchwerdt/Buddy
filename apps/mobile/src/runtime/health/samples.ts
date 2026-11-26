import type { CarbEntry, GlucoseReading, InsulinDose, Millis } from '@buddy/core';

/**
 * Pure planning of what gets written to Apple Health / Health Connect (port of Trio's
 * HealthKitManager upload rules). Platform backends turn these samples into native records.
 */

const HOUR = 3_600_000;
/** Samples are only written for the last day, like Trio's 24 h history windows. */
export const HEALTH_WINDOW_MS = 24 * HOUR;
/** Per kind and sync round, so a first sync after a long gap does not hammer the native module. */
export const MAX_SAMPLES_PER_KIND = 300;

export type HealthKind = 'glucose' | 'carbs' | 'insulin';

export type HealthSample =
  | { readonly kind: 'glucose'; readonly key: string; readonly syncId: string; readonly date: Millis; readonly mgdl: number }
  | { readonly kind: 'carbs'; readonly key: string; readonly syncId: string; readonly date: Millis; readonly grams: number }
  | { readonly kind: 'insulin'; readonly key: string; readonly syncId: string; readonly start: Millis; readonly end: Millis; readonly units: number; readonly reason: 'bolus' | 'basal'; readonly external: boolean };

export interface HealthSnapshot {
  readonly glucose: readonly GlucoseReading[];
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly CarbEntry[];
}

/** Same identifier Nightscout uses for a reading, so one id names the record everywhere. */
export const glucoseSyncId = (source: string, date: Millis): string => `${source}-${Math.round(date)}`;

/** Carb equivalents (fat/protein) and records imported from Nightscout are not meals the user entered here. */
const isOwnMeal = (id: string): boolean => !id.startsWith('fpu-') && !id.startsWith('ns-');
const isOwnDose = (id: string): boolean => !id.startsWith('ns-');

const roundTo = (value: number, step: number): number => (step > 0 ? Math.round(value / step) * step : value);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface PlanOptions {
  readonly now: Millis;
  /** Keys already written (`HealthSample.key`). */
  readonly uploaded: ReadonlySet<string>;
  /** Pump bolus increment; insulin is rounded to it like Trio's `roundToSupportedBolusVolume`. */
  readonly bolusIncrement?: number;
}

const newestFirstLimit = <T extends { date: Millis }>(items: T[]): T[] => items.sort((a, b) => a.date - b.date).slice(0, MAX_SAMPLES_PER_KIND);

export function planHealthUpload(snap: HealthSnapshot, o: PlanOptions): HealthSample[] {
  const since = o.now - HEALTH_WINDOW_MS;
  const out: HealthSample[] = [];

  const glucose = snap.glucose
    .filter((g) => g.date >= since && g.date <= o.now && Number.isFinite(g.value) && g.value > 0)
    .map((g) => ({ date: g.date, sample: { kind: 'glucose', syncId: glucoseSyncId(g.source, g.date), date: Math.round(g.date), mgdl: Math.round(g.value) } as const }))
    .map((x) => ({ date: x.date, sample: { ...x.sample, key: `glucose:${x.sample.syncId}` } satisfies HealthSample }))
    .filter((x) => !o.uploaded.has(x.sample.key));
  out.push(...newestFirstLimit(glucose).map((x) => x.sample));

  const carbs = snap.carbs
    .filter((c) => isOwnMeal(c.id) && c.date >= since && c.date <= o.now && c.grams > 0)
    .filter((c) => !o.uploaded.has(`carbs:${c.id}`))
    .map((c) => ({ date: c.date, sample: { kind: 'carbs', key: `carbs:${c.id}`, syncId: c.id, date: c.date, grams: round3(c.grams) } satisfies HealthSample }));
  out.push(...newestFirstLimit(carbs).map((x) => x.sample));

  out.push(...planInsulin(snap.doses, o, since).slice(0, MAX_SAMPLES_PER_KIND));
  return out;
}

/**
 * Boluses (SMBs and external insulin included) go in as bolus samples. A temp basal becomes a basal
 * sample of rate x time once it has settled: it ended, or the next temp basal cut it short. Trio writes it
 * at its start and corrects the predecessor later; settling first gives the same final data without rewrites.
 */
function planInsulin(doses: readonly InsulinDose[], o: PlanOptions, since: Millis): HealthSample[] {
  const step = o.bolusIncrement ?? 0;
  const samples: Array<{ date: Millis; sample: HealthSample }> = [];

  for (const d of doses) {
    if ((d.kind !== 'bolus' && d.kind !== 'smb') || !isOwnDose(d.id)) continue;
    if (d.date < since || d.date > o.now || !(d.units > 0)) continue;
    const key = `insulin:${d.id}@1`;
    if (o.uploaded.has(key)) continue;
    samples.push({ date: d.date, sample: { kind: 'insulin', key, syncId: d.id, start: d.date, end: d.date, units: round3(roundTo(d.units, step)), reason: 'bolus', external: d.kind === 'bolus' && d.external === true } });
  }

  const temps = doses.filter((d): d is Extract<InsulinDose, { kind: 'tempBasal' }> => d.kind === 'tempBasal' && isOwnDose(d.id)).sort((a, b) => a.date - b.date);
  temps.forEach((t, i) => {
    if (t.date < since || !(t.rate > 0) || !(t.durationMin > 0)) return;
    const plannedEnd = t.date + t.durationMin * 60_000;
    const next = temps[i + 1];
    const end = next ? Math.min(plannedEnd, next.date) : plannedEnd;
    const settled = next !== undefined || plannedEnd <= o.now;
    if (!settled || end <= t.date || end > o.now) return;
    const units = round3(roundTo((t.rate * (end - t.date)) / HOUR, step));
    const key = `insulin:${t.id}@1`;
    if (!(units > 0) || o.uploaded.has(key)) return;
    samples.push({ date: t.date, sample: { kind: 'insulin', key, syncId: t.id, start: t.date, end, units, reason: 'basal', external: false } });
  });

  return samples.sort((a, b) => a.date - b.date).map((x) => x.sample);
}

/** Keeps the upload ledger to the window the planner can still produce. */
export function pruneLedger(ledger: Readonly<Record<string, Millis>>, now: Millis): Record<string, Millis> {
  const cutoff = now - HEALTH_WINDOW_MS - HOUR;
  return Object.fromEntries(Object.entries(ledger).filter(([, date]) => date >= cutoff));
}

/** The record id used for a deletion, per kind. Glucose ids are `<source>-<date>`. */
export function syncIdForDeletion(kind: HealthKind, id: string, date: Millis): string {
  if (kind !== 'glucose') return id;
  return id.endsWith(`-${Math.round(date)}`) ? id : glucoseSyncId(id, date);
}
