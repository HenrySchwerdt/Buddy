import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ActiveTempTarget } from '@buddy/core';

/** Adjustments state Trio keeps that Buddy's shared settings have no field for. */
interface AdjustmentsState {
  /** Temp targets with a future start ("Scheduled Temp Targets"), oldest first. */
  readonly scheduledTempTargets: readonly ActiveTempTarget[];
  /** Trio `requireAdjustmentsConfirmation`: ask before starting a preset. */
  readonly requireAdjustmentsConfirmation: boolean;
  setScheduled(list: readonly ActiveTempTarget[]): void;
}

export const useAdjustmentsStore = create<AdjustmentsState>()(
  persist(
    (set) => ({
      scheduledTempTargets: [],
      requireAdjustmentsConfirmation: false,
      setScheduled: (list) => set({ scheduledTempTargets: [...list].sort((a, b) => a.startedAt - b.startedAt) }),
    }),
    {
      name: 'buddy.adjustments.v1',
      storage: createJSONStorage(() => Storage),
      partialize: ({ setScheduled: _s, ...rest }) => rest,
    },
  ),
);
