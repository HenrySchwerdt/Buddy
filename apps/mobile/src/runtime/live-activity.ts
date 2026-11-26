import { AppState, Platform } from 'react-native';
import { create } from 'zustand';
import { BuddyNative } from '../../modules/buddy-native';
import { STALE_AFTER_MS, contentKey, type StatusContent } from './live-activity-content';

/**
 * iOS Live Activity driver (Trio `LiveActivityManager`). Android uses the ongoing notification instead
 * (background.ts). All calls are no-ops where ActivityKit does not exist.
 */

/** Apple ends a Live Activity after 8 h active; Trio restarts before that. */
export const RESTART_AFTER_MS = 7.5 * 60 * 60_000;

export type LiveActivityState = 'unavailable' | 'off' | 'active' | 'denied' | 'waiting' | 'error';

export const useLiveActivityState = create<{ state: LiveActivityState }>(() => ({ state: 'off' }));

export const liveActivityAvailable = (): boolean => Platform.OS === 'ios' && typeof BuddyNative?.liveActivityStatus === 'function';

let lastKey = '';
const setState = (state: LiveActivityState) => {
  if (useLiveActivityState.getState().state !== state) useLiveActivityState.setState({ state });
};

const staleAt = (c: StatusContent, now: number) => Math.floor((c.readingAt > 0 ? c.readingAt * 1000 + STALE_AFTER_MS : now + STALE_AFTER_MS) / 1000);

/** True when iOS allows Live Activities for Buddy (Settings → Buddy → Live Activities). */
export function liveActivitiesAllowed(): boolean {
  return liveActivityAvailable() && BuddyNative?.liveActivityStatus?.().enabled === true;
}

/**
 * Brings the Live Activity in line with `content`. Requesting needs the app in the foreground (iOS rule), so a
 * missing activity is only started while the app is active; otherwise state "waiting" and `syncLiveActivity` is
 * called again when the app returns to the foreground.
 */
export async function syncLiveActivity(enabled: boolean, content: StatusContent, now: number): Promise<void> {
  const native = BuddyNative;
  if (!liveActivityAvailable() || !native?.liveActivityStatus) return setState('unavailable');
  try {
    const status = native.liveActivityStatus();
    if (!enabled) {
      if (status.active) await native.endLiveActivity?.();
      lastKey = '';
      return setState('off');
    }
    if (!status.enabled) return setState('denied');
    const old = status.active && now - status.startedAt * 1000 > RESTART_AFTER_MS;
    if (status.active && !old) {
      const key = contentKey(content);
      if (key !== lastKey) {
        const ok = await native.updateLiveActivity?.(content, staleAt(content, now));
        if (ok) lastKey = key;
      }
      return setState('active');
    }
    if (AppState.currentState !== 'active') return setState('waiting');
    const started = await native.startLiveActivity?.(content, staleAt(content, now));
    lastKey = started ? contentKey(content) : '';
    setState(started ? 'active' : 'error');
  } catch {
    setState('error');
  }
}

/** Trio "Restart Live Activity" (also the shortcut): ends the running activity and requests a new one. */
export async function restartLiveActivity(content: StatusContent, now: number): Promise<boolean> {
  const native = BuddyNative;
  if (!liveActivityAvailable() || !native?.startLiveActivity || !liveActivitiesAllowed()) return false;
  try {
    const ok = await native.startLiveActivity(content, staleAt(content, now));
    lastKey = ok ? contentKey(content) : '';
    setState(ok ? 'active' : 'error');
    return ok === true;
  } catch {
    setState('error');
    return false;
  }
}
