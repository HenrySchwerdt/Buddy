import { ALERT_KINDS, type AlertSnoozes, type Millis } from '@buddy/core';
import { snooze } from '@/runtime/services';
import { useSettings } from '@/runtime/settings-store';

/** Trio's NotificationResponseAction durations. */
export const SNOOZE_ACTIONS = [
  { minutes: 15, title: 'Snooze 15 min' },
  { minutes: 60, title: 'Snooze 1 hr' },
  { minutes: 180, title: 'Snooze 3 hrs' },
  { minutes: 360, title: 'Snooze 6 hrs' },
] as const;

/** Mutes every alarm kind; core caps urgent low at 15 min, so it still pierces (as in Trio). */
export function snoozeAll(minutes: number, now: Millis): void {
  for (const kind of ALERT_KINDS) snooze(kind, minutes, now);
}

/** Lifts every snooze (Trio `applySnooze(for: 0)`). */
export function endSnooze(): void {
  useSettings.getState().update({ alertSnoozes: {} });
}

/** Latest global snooze end, ignoring urgent low (always capped); null when nothing is snoozed. */
export function snoozedUntil(snoozes: AlertSnoozes, now: Millis): Millis | null {
  const ends = ALERT_KINDS.filter((k) => k !== 'urgentLow')
    .map((k) => snoozes[k])
    .filter((t): t is Millis => t !== undefined && t > now);
  return ends.length ? Math.max(...ends) : null;
}

export function formatTimeOfDay(t: Millis): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
