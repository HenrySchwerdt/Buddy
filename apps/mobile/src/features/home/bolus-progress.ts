import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { currentPump, useRuntime } from '@/runtime/runtime';

/**
 * Bolus in progress (Home `state.bolusProgress` / `bolusStatus`). Buddy's pump drivers only report
 * `bolusing`, not delivered units, so the panel is indeterminate unless the code that starts a bolus
 * also calls `begin` / `setDelivered` / `end` on this tracker.
 */
interface Tracker {
  readonly total: number | null;
  readonly delivered: number | null;
  readonly startedAt: number | null;
  begin(total: number): void;
  setDelivered(delivered: number): void;
  end(): void;
}

export const useBolusTracker = create<Tracker>((set) => ({
  total: null,
  delivered: null,
  startedAt: null,
  begin: (total) => set({ total, delivered: 0, startedAt: Date.now() }),
  setDelivered: (delivered) => set({ delivered }),
  end: () => set({ total: null, delivered: null, startedAt: null }),
}));

export type BolusStatus = 'initiating' | 'inProgress';
const POLL_MS = 2_000;
/** A tracked bolus the pump has not reported after this long is shown no more. */
const INITIATING_TIMEOUT_MS = 30_000;

export interface BolusProgress {
  readonly status: BolusStatus;
  /** 0...1 when the delivered amount is known. */
  readonly progress: number | null;
  readonly total: number | null;
  readonly delivered: number | null;
}

/** Watches the pump while it reports `bolusing` (or while a tracked bolus starts); null when idle. */
export function useBolusProgress(): BolusProgress | null {
  const pumpBolusing = useRuntime((s) => s.pump?.bolusing ?? false);
  const tracker = useBolusTracker();
  const [bolusing, setBolusing] = useState(pumpBolusing);
  const tracked = tracker.total !== null;
  const watch = pumpBolusing || tracked || bolusing;

  useEffect(() => {
    if (!watch) return;
    let alive = true;
    const poll = async () => {
      const pump = currentPump();
      if (!pump) return;
      try {
        const s = await pump.status();
        if (!alive) return;
        setBolusing(s.bolusing);
        useRuntime.setState({ pump: s });
        if (!s.bolusing && useBolusTracker.getState().startedAt && Date.now() - useBolusTracker.getState().startedAt! > INITIATING_TIMEOUT_MS) useBolusTracker.getState().end();
      } catch {
        if (alive) setBolusing(false);
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [watch]);

  if (!bolusing && !pumpBolusing && !tracked) return null;
  const known = tracker.total !== null && tracker.delivered !== null && tracker.total > 0;
  return {
    status: bolusing || pumpBolusing ? 'inProgress' : 'initiating',
    progress: known ? Math.min(1, Math.max(0, tracker.delivered! / tracker.total!)) : null,
    total: tracker.total,
    delivered: tracker.delivered,
  };
}
