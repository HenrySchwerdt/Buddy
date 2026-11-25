/**
 * Finished override / temp-target runs for History › Adjustments (Trio's OverrideRunStored and
 * TempTargetRunStored). Buddy's settings only hold the active adjustment, so this store watches
 * them and records a run when one is replaced or cancelled.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ActiveOverride, ActiveTempTarget } from '@buddy/core';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';

const MINUTE_MS = 60_000;
const KEEP_MS = 7 * 86_400_000;

export type AdjustmentKind = 'override' | 'tempTarget';

export interface AdjustmentRun {
  readonly id: string;
  readonly kind: AdjustmentKind;
  readonly name: string;
  readonly startDate: number;
  readonly endDate: number;
  /** mg/dL; null = no target change. */
  readonly target: number | null;
}

interface LogState {
  readonly runs: readonly AdjustmentRun[];
  add(run: AdjustmentRun): void;
}

export const useAdjustmentLog = create<LogState>()(
  persist(
    (set) => ({
      runs: [],
      add: (run) =>
        set((s) => ({
          runs: [...s.runs.filter((r) => r.id !== run.id && r.endDate >= run.endDate - KEEP_MS), run],
        })),
    }),
    { name: 'buddy.history.v1', storage: createJSONStorage(() => Storage) },
  ),
);

type Active = ActiveOverride | ActiveTempTarget;

/** The run an adjustment produced if it ended at `at` (planned end if that came first). */
export function runFor(kind: AdjustmentKind, a: Active, at: number): AdjustmentRun {
  const planned = a.durationMin === null ? Infinity : a.startedAt + a.durationMin * MINUTE_MS;
  const target = kind === 'tempTarget' ? (a as ActiveTempTarget).target : (a as ActiveOverride).target;
  return { id: `${kind}:${a.startedAt}`, kind, name: a.name, startDate: a.startedAt, endDate: Math.min(planned, at), target: target ?? null };
}

let started = false;

/** Start recording (idempotent). Called when the History module loads. */
export function startAdjustmentLog(): void {
  if (started) return;
  started = true;
  useSettings.subscribe((s, prev) => {
    const at = now();
    if (prev.override && prev.override !== s.override && prev.override.startedAt !== s.override?.startedAt) {
      useAdjustmentLog.getState().add(runFor('override', prev.override, at));
    }
    if (prev.tempTarget && prev.tempTarget !== s.tempTarget && prev.tempTarget.startedAt !== s.tempTarget?.startedAt) {
      useAdjustmentLog.getState().add(runFor('tempTarget', prev.tempTarget, at));
    }
  });
}

/** Runs of the last 24 h, plus active adjustments whose planned duration has already elapsed. */
export function recentAdjustments(runs: readonly AdjustmentRun[], override: ActiveOverride | null, tempTarget: ActiveTempTarget | null, at: number): AdjustmentRun[] {
  const all = [...runs];
  const expired = (kind: AdjustmentKind, a: Active | null) => {
    if (!a) return;
    const r = runFor(kind, a, at);
    if (r.endDate < at && !all.some((x) => x.id === r.id)) all.push(r);
  };
  expired('override', override);
  expired('tempTarget', tempTarget);
  return all
    .filter((r) => r.startDate >= at - 86_400_000)
    .sort((a, b) => (a.startDate === b.startDate ? b.endDate - a.endDate : b.startDate - a.startDate));
}
