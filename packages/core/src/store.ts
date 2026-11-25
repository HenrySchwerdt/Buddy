import type { LoopRun } from './loop';
import type { CarbEntry, GlucoseReading, InsulinDose, Millis } from './types';

export interface DataSnapshot {
  readonly glucose: readonly GlucoseReading[];
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly CarbEntry[];
  readonly loopRuns: readonly LoopRun[];
}

export interface DataStore {
  snapshot(): DataSnapshot;
  addGlucose(readings: readonly GlucoseReading[]): void;
  addDoses(doses: readonly InsulinDose[]): void;
  addCarbs(entry: CarbEntry): void;
  removeCarbs(id: string): void;
  /** Removes one reading (e.g. a mistaken manual entry) by source and timestamp. */
  removeGlucose(source: string, date: Millis): void;
  addLoopRun(run: LoopRun): void;
  subscribe(listener: (s: DataSnapshot) => void): () => void;
  /** Drop data older than `before`. */
  prune(before: Millis): void;
  replace(snapshot: DataSnapshot): void;
}

export const EMPTY_SNAPSHOT: DataSnapshot = { glucose: [], doses: [], carbs: [], loopRuns: [] };

const MAX_LOOP_RUNS = 600;

function mergeBy<T>(existing: readonly T[], incoming: readonly T[], key: (t: T) => string, date: (t: T) => number): readonly T[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map(key));
  const fresh = incoming.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (fresh.length === 0) return existing;
  return [...existing, ...fresh].sort((a, b) => date(a) - date(b));
}

/**
 * Doses are upserted: a pump may re-report the same dose id with corrected contents
 * (a temp basal cut short, a suspend whose duration became known, a bolus whose delivered
 * amount was finalised). The newest report must win, otherwise IOB is computed from stale data.
 */
function upsertDoses(existing: readonly InsulinDose[], incoming: readonly InsulinDose[]): readonly InsulinDose[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((d) => [d.id, d]));
  let changed = false;
  for (const d of incoming) {
    const old = byId.get(d.id);
    if (old && JSON.stringify(old) === JSON.stringify(d)) continue;
    byId.set(d.id, d);
    changed = true;
  }
  return changed ? [...byId.values()].sort((a, b) => a.date - b.date) : existing;
}

/** In-memory store with immutable snapshots. Persistence adapters wrap this. */
export function createMemoryStore(initial: DataSnapshot = EMPTY_SNAPSHOT): DataStore {
  let state = initial;
  const listeners = new Set<(s: DataSnapshot) => void>();
  const set = (next: DataSnapshot) => {
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l(state));
  };
  return {
    snapshot: () => state,
    addGlucose: (r) => set({ ...state, glucose: mergeBy(state.glucose, r, (g) => `${g.source}:${g.date}`, (g) => g.date) }),
    addDoses: (d) => {
      const doses = upsertDoses(state.doses, d);
      if (doses !== state.doses) set({ ...state, doses });
    },
    addCarbs: (c) => set({ ...state, carbs: mergeBy(state.carbs, [c], (x) => x.id, (x) => x.date) }),
    removeCarbs: (id) => set({ ...state, carbs: state.carbs.filter((c) => c.id !== id) }),
    removeGlucose: (source, date) => set({ ...state, glucose: state.glucose.filter((g) => !(g.source === source && g.date === date)) }),
    addLoopRun: (run) => set({ ...state, loopRuns: [...state.loopRuns, run].slice(-MAX_LOOP_RUNS) }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prune: (before) =>
      set({
        glucose: state.glucose.filter((g) => g.date >= before),
        doses: state.doses.filter((d) => d.date >= before),
        carbs: state.carbs.filter((c) => c.date >= before),
        loopRuns: state.loopRuns.filter((r) => r.date >= before),
      }),
    replace: (s) => set(s),
  };
}
