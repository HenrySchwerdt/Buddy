import Storage from 'expo-sqlite/kv-store';
import { AppState } from 'react-native';
import type { AlertSettings } from '@buddy/core';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { migrateAlarms, msUntilNextBoundary, normalizeAlarm, removeAlarm, resolveAlertSettings, upsertAlarm, type GlucoseAlarm } from './alarms';

interface State {
  /** False until the list was seeded from the single-alarm settings of earlier builds. */
  readonly initialized: boolean;
  readonly alarms: readonly GlucoseAlarm[];
  save(alarm: GlucoseAlarm): void;
  remove(id: string): void;
}

/** The glucose alarm list (GlucoseAlertsStore). Stored on its own; the engine copy lives in `useSettings().alerts`. */
export const useGlucoseAlarms = create<State>()(
  persist(
    (set) => ({
      initialized: false,
      alarms: [],
      save: (alarm) => set((s) => ({ alarms: upsertAlarm(s.alarms, normalizeAlarm(alarm)) })),
      remove: (id) => set((s) => ({ alarms: removeAlarm(s.alarms, id) })),
    }),
    { name: 'buddy.glucose-alarms.v1', version: 1, storage: createJSONStorage(() => Storage), partialize: ({ initialized, alarms }) => ({ initialized, alarms }) },
  ),
);

const hydrated = <T extends { persist: { hasHydrated(): boolean; onFinishHydration(fn: () => void): () => void } }>(store: T) =>
  new Promise<void>((resolve) => {
    if (store.persist.hasHydrated()) resolve();
    else {
      const off = store.persist.onFinishHydration(() => {
        off();
        resolve();
      });
    }
  });

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Day / Night boundaries are wall-clock times: always evaluate them in the device's current UTC offset. */
const withLocalOffset = (alerts: AlertSettings, at: number): AlertSettings => ({ ...alerts, quietHours: { ...alerts.quietHours, utcOffsetMinutes: -new Date(at).getTimezoneOffset() } });

/** Writes the engine settings that apply right now into `useSettings().alerts` (no-op when nothing changed). */
export function applyResolvedAlerts(): void {
  const { alarms, initialized } = useGlucoseAlarms.getState();
  if (!initialized) return;
  const settings = useSettings.getState();
  const next = resolveAlertSettings(alarms, withLocalOffset(settings.alerts, now()), now());
  if (JSON.stringify(next) !== JSON.stringify(settings.alerts)) settings.update({ alerts: next });
}

function scheduleBoundary(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    applyResolvedAlerts();
    scheduleBoundary();
  }, msUntilNextBoundary(withLocalOffset(useSettings.getState().alerts, now()).quietHours, now()));
}

/**
 * Seeds the list from the current single-alarm settings on first run, then keeps `alerts` in step:
 * on every list or Day / Night change, at each window boundary and whenever the app comes to the foreground.
 */
export function startGlucoseAlarmSync(): void {
  if (started) return;
  started = true;
  void Promise.all([hydrated(useGlucoseAlarms), hydrated(useSettings)]).then(() => {
    if (!useGlucoseAlarms.getState().initialized) useGlucoseAlarms.setState({ initialized: true, alarms: migrateAlarms(useSettings.getState().alerts) });
    applyResolvedAlerts();
    scheduleBoundary();
    useGlucoseAlarms.subscribe(() => {
      applyResolvedAlerts();
      scheduleBoundary();
    });
    let boundaries = JSON.stringify(useSettings.getState().alerts.quietHours);
    useSettings.subscribe((s) => {
      const q = JSON.stringify(s.alerts.quietHours);
      if (q === boundaries) return;
      boundaries = q;
      applyResolvedAlerts();
      scheduleBoundary();
    });
    AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        applyResolvedAlerts();
        scheduleBoundary();
      }
    });
  });
}
