import * as Calendar from 'expo-calendar/legacy';
import { Platform } from 'react-native';
import { carbsOnBoard, computeIob } from '@buddy/core';
import { buildCalendarEvent } from './calendar-text';
import type { ServiceHost } from './service-host';
import { useSettings } from './settings-store';

/** Trio CalendarManager: one calendar event with the current glucose, replaced after every loop cycle. */

export interface CalendarChoice {
  readonly id: string;
  readonly title: string;
}

const DAY = 24 * 3_600_000;
let lastLoopDate = 0;
let busy = false;

/** Trio `requestAccessIfNeeded`. */
export async function requestCalendarAccess(): Promise<boolean> {
  try {
    const current = await Calendar.getCalendarPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    return (await Calendar.requestCalendarPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** Calendars that accept new events. */
export async function listCalendars(): Promise<CalendarChoice[]> {
  const all = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  return all.filter((c) => c.allowsModifications).map((c) => ({ id: c.id, title: c.title }));
}

async function pickCalendar(): Promise<CalendarChoice | null> {
  const calendars = await listCalendars();
  const wanted = useSettings.getState().calendarTitle;
  return calendars.find((c) => c.title === wanted) ?? (wanted ? null : (calendars[0] ?? null));
}

/** Replaces the event after a loop run. Never throws; skipped when nothing new happened since the last event. */
export async function updateCalendarEvent(host: ServiceHost): Promise<void> {
  const s = useSettings.getState();
  if (!s.useCalendar || host.isDemo() || busy || Platform.OS === 'web') return;
  const snap = host.store.snapshot();
  const run = snap.loopRuns.at(-1);
  if (!run || run.date === lastLoopDate || snap.glucose.length < 2) return;
  busy = true;
  try {
    if (!(await requestCalendarAccess())) return;
    const calendar = await pickCalendar();
    if (!calendar) return;
    const now = host.now();
    const last = snap.glucose.at(-1)!;
    const previous = snap.glucose.at(-2)!;
    const old = await Calendar.getEventsAsync([calendar.id], new Date(now - DAY), new Date(now + 10 * 60_000));
    for (const e of old.filter((x) => x.notes === 'Buddy')) await Calendar.deleteEventAsync(e.id).catch(() => {});
    const text = buildCalendarEvent({
      unit: s.units,
      glucose: last.value,
      previousGlucose: previous.value,
      ...(last.trend ? { trend: last.trend } : {}),
      iob: computeIob(snap.doses, s.profile, now).iob,
      cob: carbsOnBoard(snap.carbs, now),
      loopAgeMinutes: Math.max(0, (now - run.date) / 60_000),
      low: s.alerts.low.threshold,
      high: s.alerts.high.threshold,
      displayIobAndCob: s.displayCalendarIOBandCOB,
      displayEmojis: s.displayCalendarEmojis,
      now,
    });
    await Calendar.createEventAsync(calendar.id, {
      title: text.title,
      notes: text.notes,
      startDate: new Date(text.startDate),
      endDate: new Date(text.endDate),
      ...(text.location ? { location: text.location } : {}),
    });
    lastLoopDate = run.date;
  } catch (e) {
    console.warn(`[buddy] Calendar event failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy = false;
  }
}

/** Forces the next loop to write an event (after the settings changed). */
export const resetCalendarEvent = (): void => {
  lastLoopDate = 0;
};
