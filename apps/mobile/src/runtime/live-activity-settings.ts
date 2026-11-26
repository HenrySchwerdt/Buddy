import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_LIVE_ACTIVITY_SETTINGS, type LiveActivitySettings } from './live-activity-content';

interface Actions {
  update(patch: Partial<LiveActivitySettings>): void;
}

/** Trio `LiveActivitySettings` (+ the Android foreground service switch). Persisted like the other preference stores. */
export const useLiveActivitySettings = create<LiveActivitySettings & Actions>()(
  persist(
    (set) => ({
      ...DEFAULT_LIVE_ACTIVITY_SETTINGS,
      update: (patch) => set((s) => ({ ...s, ...patch })),
    }),
    {
      name: 'buddy.live-activity.v1',
      version: 1,
      storage: createJSONStorage(() => Storage),
      migrate: (persisted) => ({ ...DEFAULT_LIVE_ACTIVITY_SETTINGS, ...(persisted as Partial<LiveActivitySettings>) }),
      partialize: ({ update: _u, ...rest }) => rest,
    },
  ),
);
