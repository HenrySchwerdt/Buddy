import { AppRegistry, AppState, Platform, type AppStateStatus } from 'react-native';
import { create } from 'zustand';
import { carbsOnBoard, computeIob, isOverrideActive, isTempTargetActive, type DataSnapshot } from '@buddy/core';
import { BuddyNative } from '../../modules/buddy-native';
import { useTrioPrefs } from '@/features/settings/store';
import { useMealPresets } from '@/features/treatment/presets-store';
import { setBackgroundTaskRegistered, whenSettingsHydrated, type BackgroundTaskState } from './background-task';
import { buildStatusContent, notificationText, type StatusContent } from './live-activity-content';
import { useLiveActivitySettings } from './live-activity-settings';
import { liveActivityAvailable, restartLiveActivity, syncLiveActivity } from './live-activity';
import { useSettings } from './settings-store';
import { buildShortcutState, dynamicShortcuts } from './shortcuts-state';

/**
 * Native OS services around the runtime:
 *  - iOS: Live Activity (lock screen / Dynamic Island), App Intents state, periodic background task.
 *  - Android: foreground service + ongoing notification that keeps the JS runtime alive, launcher shortcuts,
 *    periodic background task.
 * runtime.ts calls `startNativeServices` after every (re)start; the services then follow the store on their own.
 * This module must not import runtime.ts statically (runtime.ts imports it): the runtime hands in what it needs.
 */

export interface NativeServicesDeps {
  /** A real pump or CGM is configured (not the simulator). The Android foreground service only runs then. */
  readonly real: boolean;
  readonly demo: boolean;
  readonly store: { snapshot(): DataSnapshot; subscribe(listener: (s: DataSnapshot) => void): () => void };
  readonly now: () => number;
}

export interface NativeServicesStatus {
  readonly androidService: 'off' | 'running' | 'error';
  readonly androidError: string | null;
  readonly backgroundTask: BackgroundTaskState;
}

export const useNativeServices = create<NativeServicesStatus>(() => ({ androidService: 'off', androidError: null, backgroundTask: 'unavailable' }));

export const HEADLESS_TASK = 'BuddyForeground';
const SYNC_DEBOUNCE_MS = 2_000;
const HEARTBEAT_MS = 60_000;
/** Never ask Android to start the service more often than this (it may refuse from the background). */
const SERVICE_RETRY_MS = 60_000;
/** Headless task: how often it checks that the service is still wanted. */
const HEADLESS_POLL_MS = 30_000;

let deps: NativeServicesDeps | null = null;
let detach: Array<() => void> = [];
let debounce: ReturnType<typeof setTimeout> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let lastNotification = '';
let lastShortcutState = '';
let lastDynamicShortcuts = '';
let lastServiceAttempt = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function currentContent(d: NativeServicesDeps): StatusContent {
  const now = d.now();
  const snap = d.store.snapshot();
  const s = useSettings.getState();
  const prefs = useTrioPrefs.getState();
  return buildStatusContent(
    {
      glucose: snap.glucose.slice(-240),
      iob: computeIob(snap.doses, s.profile, now).iob,
      cob: carbsOnBoard(snap.carbs, now),
      lastLoopAt: snap.loopRuns.at(-1)?.date ?? null,
      units: s.units,
      low: prefs.low,
      high: prefs.high,
      now,
    },
    useLiveActivitySettings.getState(),
  );
}

function syncIosShortcutState(d: NativeServicesDeps, content: StatusContent) {
  if (!BuddyNative?.setShortcutState) return;
  const s = useSettings.getState();
  const now = d.now();
  const json = JSON.stringify(
    buildShortcutState({
      status: content,
      allowBolus: useTrioPrefs.getState().allowBolusByShortcuts,
      override: isOverrideActive(s.override, now) ? s.override.name : null,
      tempTarget: isTempTargetActive(s.tempTarget, now) ? s.tempTarget.name : null,
      overridePresets: s.overridePresets,
      tempTargetPresets: s.tempTargetPresets,
      mealPresets: useMealPresets.getState().presets,
      now,
    }),
  );
  // updatedAt changes every time; compare the rest so unchanged state is not rewritten on every heartbeat.
  const key = json.replace(/"updatedAt":\d+/, '');
  if (key === lastShortcutState) return;
  lastShortcutState = key;
  BuddyNative.setShortcutState(json);
}

function syncAndroid(d: NativeServicesDeps, content: StatusContent) {
  const native = BuddyNative;
  if (!native?.startForegroundService) return;
  const s = useSettings.getState();
  const shortcuts = JSON.stringify(dynamicShortcuts(s.overridePresets, s.tempTargetPresets));
  if (shortcuts !== lastDynamicShortcuts) {
    lastDynamicShortcuts = shortcuts;
    native.setDynamicShortcuts?.(JSON.parse(shortcuts));
  }
  const wanted = d.real && useLiveActivitySettings.getState().androidForegroundService;
  const running = native.isForegroundServiceRunning?.() === true;
  if (!wanted) {
    if (running) native.stopForegroundService?.();
    lastNotification = '';
    useNativeServices.setState({ androidService: 'off', androidError: null });
    return;
  }
  const text = notificationText(content);
  if (running) {
    const key = JSON.stringify(text);
    if (key !== lastNotification) {
      lastNotification = key;
      native.updateForegroundNotification?.(text.title, text.text, text.when);
    }
    useNativeServices.setState({ androidService: 'running', androidError: null });
    return;
  }
  if (d.now() - lastServiceAttempt < SERVICE_RETRY_MS) return;
  lastServiceAttempt = d.now();
  void native.startForegroundService(text.title, text.text, text.when).then((ok) => {
    lastNotification = ok ? JSON.stringify(text) : '';
    useNativeServices.setState({ androidService: ok ? 'running' : 'error', androidError: ok ? null : (native.foregroundServiceError?.() ?? 'Android refused to start the service') });
  });
}

function sync() {
  const d = deps;
  if (!d) return;
  const content = currentContent(d);
  if (Platform.OS === 'ios') {
    void syncLiveActivity(useLiveActivitySettings.getState().enabled, content, d.now());
    syncIosShortcutState(d, content);
  } else if (Platform.OS === 'android') {
    syncAndroid(d, content);
  }
}

function scheduleSync() {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(sync, SYNC_DEBOUNCE_MS);
}

/** Trio "Restart Live Activity" (button and shortcut): needs the app in the foreground. */
export async function restartLiveActivityNow(): Promise<boolean> {
  return deps ? restartLiveActivity(currentContent(deps), deps.now()) : false;
}

/** Latest status for the in-app state screen; null before the runtime started. */
export function currentShortcutState() {
  const d = deps;
  if (!d) return null;
  const s = useSettings.getState();
  const now = d.now();
  return buildShortcutState({
    status: currentContent(d),
    allowBolus: useTrioPrefs.getState().allowBolusByShortcuts,
    override: isOverrideActive(s.override, now) ? s.override.name : null,
    tempTarget: isTempTargetActive(s.tempTarget, now) ? s.tempTarget.name : null,
    overridePresets: s.overridePresets,
    tempTargetPresets: s.tempTargetPresets,
    mealPresets: useMealPresets.getState().presets,
    now,
  });
}

/** Immediate sync (settings toggled by the user). */
export const syncNativeServicesNow = () => sync();

/**
 * Starts or reconfigures the services; safe to call after every runtime restart. Does nothing on web / Expo Go
 * (the native module is missing there) except keeping the background task registered where the OS has one.
 */
export function startNativeServices(next: NativeServicesDeps): void {
  stopListening();
  deps = next;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  detach = [
    next.store.subscribe(scheduleSync),
    useSettings.subscribe(scheduleSync),
    useLiveActivitySettings.subscribe(sync),
    useTrioPrefs.subscribe(scheduleSync),
    useMealPresets.subscribe(scheduleSync),
    (() => {
      const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
        if (state === 'active') sync();
      });
      return () => sub.remove();
    })(),
  ];
  heartbeat = setInterval(sync, HEARTBEAT_MS);
  void setBackgroundTaskRegistered(next.real).then((backgroundTask) => useNativeServices.setState({ backgroundTask }));
  sync();
}

function stopListening() {
  for (const off of detach) off();
  detach = [];
  if (debounce) clearTimeout(debounce);
  debounce = null;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/** Stops the services (Android foreground service, Live Activity) and the background task. */
export function stopNativeServices(): void {
  stopListening();
  deps = null;
  lastNotification = '';
  lastServiceAttempt = 0;
  if (Platform.OS === 'android') BuddyNative?.stopForegroundService?.();
  if (liveActivityAvailable()) void BuddyNative?.endLiveActivity?.();
  void setBackgroundTaskRegistered(false).then((backgroundTask) => useNativeServices.setState({ backgroundTask }));
  useNativeServices.setState({ androidService: 'off', androidError: null });
}

/**
 * The foreground service's headless JS task. It runs for as long as the service lives: it keeps JS timers
 * running while the app is in the background and, after Android killed the process and restarted the service,
 * boots the runtime without any UI.
 */
async function foregroundTask(): Promise<void> {
  await whenSettingsHydrated();
  if (useSettings.getState().onboarded) {
    const { startRuntime } = await import('./runtime');
    await startRuntime();
  }
  while (BuddyNative?.isForegroundServiceRunning?.() === true) await sleep(HEADLESS_POLL_MS);
}

if (Platform.OS === 'android') AppRegistry.registerHeadlessTask(HEADLESS_TASK, () => foregroundTask);
