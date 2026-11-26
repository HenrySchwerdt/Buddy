import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { MINUTE } from '@buddy/core';
import { useSettings } from './settings-store';

/**
 * Periodic background wake-up (iOS BGTaskScheduler processing task, Android WorkManager). The system decides
 * when it runs: at best every ~15 minutes, often much less, never while the user force-quit the app (iOS), and
 * not at all in Low Power Mode. It is a safety net that refreshes data and runs one loop cycle, not a scheduler:
 * the 5-minute loop cadence comes from the app being kept alive (iOS: Bluetooth background mode; Android:
 * the foreground service).
 *
 * `TaskManager.defineTask` must run at module scope so the task exists when the app is launched in the background.
 */

export const BACKGROUND_LOOP_TASK = 'buddy-background-loop';
/** Minimum interval requested; the OS treats it as a lower bound. */
export const BACKGROUND_INTERVAL_MIN = 15;
/** A loop cycle is only run when the last one is at least this old (or newer glucose arrived). */
export const TICK_MIN_AGE_MS = 4 * MINUTE;

export function whenSettingsHydrated(): Promise<void> {
  if (useSettings.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useSettings.persist.onFinishHydration(() => {
      off();
      resolve();
    });
  });
}

/** What a background wake does: start the runtime if needed, run one loop cycle if due. Returns what happened. */
export async function backgroundTick(): Promise<'skipped' | 'idle' | 'looped'> {
  await whenSettingsHydrated();
  if (!useSettings.getState().onboarded) return 'skipped';
  // Imported lazily: runtime.ts imports this module's siblings, and a headless launch must not pay for it before it is needed.
  const { startRuntime, runLoop, store, now } = await import('./runtime');
  await startRuntime();
  const snap = store.snapshot();
  const lastLoop = snap.loopRuns.at(-1)?.date ?? 0;
  const latestGlucose = snap.glucose.at(-1)?.date ?? 0;
  if (now() - lastLoop < TICK_MIN_AGE_MS && latestGlucose <= lastLoop) return 'idle';
  await runLoop();
  return 'looped';
}

TaskManager.defineTask(BACKGROUND_LOOP_TASK, async () => {
  try {
    await backgroundTick();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    console.warn(`[buddy] Background task failed: ${String(e)}`);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export type BackgroundTaskState = 'unavailable' | 'registered' | 'unregistered';

/** Registers (or removes) the periodic task. Never throws: the platform may refuse (Low Power Mode, simulator, Expo Go). */
export async function setBackgroundTaskRegistered(registered: boolean): Promise<BackgroundTaskState> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return 'unavailable';
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOOP_TASK);
    if (registered && !isRegistered) await BackgroundTask.registerTaskAsync(BACKGROUND_LOOP_TASK, { minimumInterval: BACKGROUND_INTERVAL_MIN });
    if (!registered && isRegistered) await BackgroundTask.unregisterTaskAsync(BACKGROUND_LOOP_TASK);
    return registered ? 'registered' : 'unregistered';
  } catch {
    return 'unavailable';
  }
}
