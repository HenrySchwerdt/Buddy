import { toMmol, type GlucoseUnit, type Millis, type Trend } from '@buddy/core';

/** Pure text of Trio's calendar event (CalendarManager.createEvent) and of the glucose app badge (UserNotificationsManager.addAppBadge). */

/** Trio `BloodGlucose.Direction.symbol`. */
export const TREND_SYMBOL: Record<Trend, string> = {
  doubleUp: '↑↑',
  singleUp: '↑',
  fortyFiveUp: '↗︎',
  flat: '→',
  fortyFiveDown: '↘︎',
  singleDown: '↓',
  doubleDown: '↓↓',
  unknown: '↔︎',
};

const trim1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/** Glucose as shown to the user: whole mg/dL or one-decimal mmol/L. */
export const formatGlucose = (mgdl: number, unit: GlucoseUnit): string => (unit === 'mmol/L' ? toMmol(mgdl).toFixed(1) : String(Math.round(mgdl)));

/** Signed delta (Trio `formattedDelta`): `+5`, `-0.3`, `+0`. */
export function formatDelta(deltaMgdl: number, unit: GlucoseUnit): string {
  const v = unit === 'mmol/L' ? Math.round(toMmol(deltaMgdl) * 10) / 10 : Math.round(deltaMgdl);
  return `${v < 0 ? '-' : '+'}${Math.abs(v)}`;
}

export interface CalendarEventInput {
  readonly unit: GlucoseUnit;
  readonly glucose: number;
  readonly previousGlucose: number;
  readonly trend?: Trend;
  readonly iob: number;
  readonly cob: number;
  /** Minutes since the last loop cycle. */
  readonly loopAgeMinutes: number;
  readonly low: number;
  readonly high: number;
  readonly displayIobAndCob: boolean;
  readonly displayEmojis: boolean;
  readonly now: Millis;
}

export interface CalendarEventText {
  readonly title: string;
  readonly location?: string;
  readonly notes: string;
  readonly startDate: Millis;
  readonly endDate: Millis;
}

const EVENT_LENGTH_MS = 10 * 60_000;
/** Trio: a loop older than this shows the "not looping" emoji. */
const STALE_LOOP_MINUTES = 15;

export function buildCalendarEvent(i: CalendarEventInput): CalendarEventText {
  let icon = '🟢';
  if (i.displayEmojis) {
    if (i.glucose <= i.low) icon = '🔴';
    if (i.glucose >= i.high) icon = '🟠';
    if (i.loopAgeMinutes > STALE_LOOP_MINUTES) icon = '🚫';
  }
  const direction = TREND_SYMBOL[i.trend ?? 'unknown'];
  const title = `${i.displayEmojis ? `${icon} ` : ''}${formatGlucose(i.glucose, i.unit)} ${direction} ${formatDelta(i.glucose - i.previousGlucose, i.unit)}`;
  const base = { title, notes: 'Buddy', startDate: i.now, endDate: i.now + EVENT_LENGTH_MS };
  if (!i.displayIobAndCob) return base;
  const iob = `${i.displayEmojis ? '💉' : 'IOB:'} ${trim1(i.iob)}`;
  const cob = `${i.displayEmojis ? '🥨' : 'COB:'} ${Math.round(i.cob)}`;
  return { ...base, location: `${iob} ${cob}` };
}

/** Trio `addAppBadge`: whole mg/dL, or mmol/L x 10 rounded (badges are integers). */
export const glucoseBadgeValue = (mgdl: number, unit: GlucoseUnit): number => (unit === 'mmol/L' ? Math.round(toMmol(mgdl) * 10) : Math.round(mgdl));
