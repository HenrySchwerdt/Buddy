import { requireOptionalNativeModule } from 'expo';

/** Wire shape of the Live Activity state; mirrors `StatusContent` in src/runtime/live-activity-content.ts. */
export interface NativeStatusContent {
  readonly glucose: string;
  readonly unit: string;
  readonly arrow: string;
  readonly delta: string;
  readonly glucoseMgdl: number;
  readonly readingAt: number;
  readonly lastLoopAt: number;
  readonly iob: string;
  readonly cob: string;
  readonly low: number;
  readonly high: number;
  readonly stale: boolean;
  readonly style: string;
  readonly fontSize: string;
  readonly showIob: boolean;
  readonly showCob: boolean;
  readonly showUpdated: boolean;
  readonly chartAges: readonly number[];
  readonly chartValues: readonly number[];
}

export interface LiveActivityStatus {
  /** iOS 16.2+ and ActivityKit present. */
  readonly supported: boolean;
  /** The user allows Live Activities for Buddy in iOS Settings. */
  readonly enabled: boolean;
  /** Buddy currently has a Live Activity running. */
  readonly active: boolean;
  /** Epoch seconds the running activity was requested; 0 when none. */
  readonly startedAt: number;
}

export interface NativeShortcut {
  readonly id: string;
  readonly shortLabel: string;
  readonly longLabel: string;
  /** buddy:// deep link. */
  readonly url: string;
}

interface BuddyNativeApi {
  // iOS ───────────────────────────────────────────────
  liveActivityStatus?(): LiveActivityStatus;
  /** Requests a new Live Activity (the app must be in the foreground). Resolves false when ActivityKit refuses. */
  startLiveActivity?(content: NativeStatusContent, staleAt: number): Promise<boolean>;
  updateLiveActivity?(content: NativeStatusContent, staleAt: number): Promise<boolean>;
  endLiveActivity?(): Promise<void>;
  /** JSON read by the App Intents (Get State, Bolus switch). */
  setShortcutState?(json: string): void;
  /**
   * Starts a UIApplication background task, so work that began while iOS woke the app (a BLE reading, a loop run)
   * can finish before the app is suspended again. Returns its id, or 0 when iOS refused. The expiration handler
   * ends the task natively; `endBackgroundTask` is idempotent. A no-op returning 0 on Android.
   */
  beginBackgroundTask?(name: string): number;
  endBackgroundTask?(id: number): void;
  // Android ───────────────────────────────────────────
  /** Starts the foreground service (and its headless JS task). Resolves false when Android refuses. */
  startForegroundService?(title: string, text: string, whenMs: number): Promise<boolean>;
  updateForegroundNotification?(title: string, text: string, whenMs: number): void;
  stopForegroundService?(): void;
  isForegroundServiceRunning?(): boolean;
  /** Reason the last start failed; null when it did not. */
  foregroundServiceError?(): string | null;
  setDynamicShortcuts?(shortcuts: readonly NativeShortcut[]): void;
}

/** Null on web, in Expo Go, or in a build made before the module was added. */
export const BuddyNative = requireOptionalNativeModule<BuddyNativeApi>('BuddyNative');
