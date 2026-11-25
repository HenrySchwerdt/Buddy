import { addDays, startOfDay, type Interval } from './calc';

const TOLERANCE_MS = 15 * 60_000;

/** StatChartUtils.formatVisibleDateRange. */
export function formatVisibleRange(start: number, end: number, interval: Interval): string {
  const short = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  if (interval !== 'day') return `${short(start)} - ${short(end)}`;
  const dayStart = startOfDay(start);
  const next = addDays(dayStart, 1);
  if (Math.abs(start - dayStart) < TOLERANCE_MS && Math.abs(end - next) < TOLERANCE_MS) {
    return new Date(dayStart).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }
  return `${short(start)} - ${short(end)}`;
}

/** Popover heading: "Wed, Nov 25" plus the hour range in D. */
export function bucketTitle(date: number, interval: Interval): string {
  const day = new Date(date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (interval !== 'day') return day;
  const h = new Date(date).getHours();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day}\n${pad(h)}:00 – ${pad((h + 1) % 24)}:00`;
}
