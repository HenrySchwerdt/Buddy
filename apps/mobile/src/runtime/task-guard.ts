/**
 * Background task guard: keeps the app running a little longer after iOS woke it, so work that is in progress
 * (reading a CGM value, one loop cycle with its uploads) can finish before the app is suspended again.
 *
 * On iOS this wraps `UIApplication.beginBackgroundTask` through the local `buddy-native` module (the system gives
 * roughly 30 s per wake and ends the task itself when that is used up). Without the native module (Expo Go, Android,
 * tests) it is a bookkeeping-only fallback: tasks are tracked in JS so callers behave the same, but nothing extends
 * the app's lifetime. This file imports nothing native so it runs under vitest.
 */

export interface NativeTaskApi {
  beginBackgroundTask?(name: string): number;
  endBackgroundTask?(id: number): void;
}

/** A task kept open while activity keeps arriving (BLE notifications), released `holdMs` after the last `touch()`. */
export interface RenewableTask {
  touch(): void;
  release(): void;
}

export interface TaskGuard {
  /** Opens a task; returns a handle for `end`. Never throws. */
  begin(name: string): number;
  /** Idempotent. */
  end(handle: number): void;
  /** Runs `fn` inside a task that is ended in `finally`. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  renewable(name: string, holdMs: number): RenewableTask;
  /** Tasks begun and not ended yet (diagnostics, tests). */
  readonly openCount: number;
}

/** How long a BLE wake keeps its task: long enough to read one reading, short of iOS's own limit. */
export const BLE_WAKE_HOLD_MS = 25_000;

export function createTaskGuard(native: NativeTaskApi | null | undefined): TaskGuard {
  /** Our handle -> the native id (0 when the OS refused or there is no native module). */
  const open = new Map<number, number>();
  let next = 1;

  const begin = (name: string): number => {
    const handle = next++;
    let nativeId = 0;
    try {
      nativeId = native?.beginBackgroundTask?.(name) ?? 0;
    } catch {
      nativeId = 0; // the guard is a courtesy; a native failure must never break the work it wraps
    }
    open.set(handle, nativeId);
    return handle;
  };

  const end = (handle: number): void => {
    const nativeId = open.get(handle);
    if (nativeId === undefined) return;
    open.delete(handle);
    if (nativeId === 0) return;
    try {
      native?.endBackgroundTask?.(nativeId);
    } catch {
      // already ended by the expiration handler
    }
  };

  return {
    begin,
    end,
    async run(name, fn) {
      const handle = begin(name);
      try {
        return await fn();
      } finally {
        end(handle);
      }
    },
    renewable(name, holdMs) {
      let handle: number | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const release = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (handle !== null) end(handle);
        handle = null;
      };
      return {
        touch() {
          handle ??= begin(name);
          if (timer) clearTimeout(timer);
          timer = setTimeout(release, holdMs);
        },
        release,
      };
    },
    get openCount() {
      return open.size;
    },
  };
}
