import { useSyncExternalStore } from 'react';
import { carbsOnBoard, computeIob, glucoseStatus, type DataSnapshot, type LoopRun } from '@buddy/core';
import { store, useRuntime } from './runtime';
import { useSettings } from './settings-store';

export function useSnapshot(): DataSnapshot {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

export function useLatestRun(): LoopRun | null {
  const snap = useSnapshot();
  return snap.loopRuns.at(-1) ?? null;
}

/** Live numbers for the home screen, derived (never stored). */
export function useLiveState() {
  const snap = useSnapshot();
  const now = useRuntime((s) => s.now);
  const profile = useSettings((s) => s.profile);
  const recent = snap.glucose.slice(-60).slice().reverse();
  const status = glucoseStatus(recent);
  const last = snap.glucose.at(-1) ?? null;
  return {
    now,
    last,
    status,
    minutesAgo: last ? Math.max(0, Math.round((now - last.date) / 60_000)) : null,
    iob: computeIob(snap.doses, profile, now),
    cob: carbsOnBoard(snap.carbs, now),
  };
}
