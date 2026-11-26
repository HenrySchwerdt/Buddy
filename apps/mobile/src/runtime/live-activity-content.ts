import { formatDelta, formatGlucose, MINUTE, type GlucoseReading, type GlucoseUnit, type Trend } from '@buddy/core';

/**
 * What the lock screen / Dynamic Island Live Activity (iOS) and the ongoing notification (Android) show:
 * Trio's LiveActivityAttributes.ContentState reduced to Buddy's data. Pure: same input, same output.
 */

export type LockScreenView = 'simple' | 'detailed';
export type LiveActivityFontSize = 'small' | 'standard' | 'large';

export interface LiveActivitySettings {
  /** Trio `useLiveActivity`. */
  readonly enabled: boolean;
  /** Trio `lockScreenView`. */
  readonly lockScreenView: LockScreenView;
  /** Trio `liveActivitySimpleFontSize`. */
  readonly simpleFontSize: LiveActivityFontSize;
  /** Detailed view items (Trio's widget item configuration). */
  readonly showIob: boolean;
  readonly showCob: boolean;
  readonly showUpdated: boolean;
  /** Glucose trend chart in the detailed view. */
  readonly showChart: boolean;
  /** Android only: keep the runtime alive with a foreground service while a real pump/CGM is configured. */
  readonly androidForegroundService: boolean;
}

export const DEFAULT_LIVE_ACTIVITY_SETTINGS: LiveActivitySettings = {
  enabled: false,
  lockScreenView: 'simple',
  simpleFontSize: 'large',
  showIob: true,
  showCob: true,
  showUpdated: true,
  showChart: true,
  androidForegroundService: true,
};

export interface StatusInput {
  readonly glucose: readonly GlucoseReading[];
  readonly iob: number | null;
  readonly cob: number | null;
  /** Date of the last loop run; null when the loop has not run. */
  readonly lastLoopAt: number | null;
  readonly units: GlucoseUnit;
  /** Colour thresholds, mg/dL. */
  readonly low: number;
  readonly high: number;
  readonly now: number;
}

/** Sent to the native side as-is. Every field is JSON-safe; dates are epoch seconds (0 = unknown). */
export interface StatusContent {
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
  readonly style: LockScreenView;
  readonly fontSize: LiveActivityFontSize;
  readonly showIob: boolean;
  readonly showCob: boolean;
  readonly showUpdated: boolean;
  /** Chart samples, oldest first: minutes before the newest reading, and mg/dL. Empty when the chart is hidden. */
  readonly chartAges: readonly number[];
  readonly chartValues: readonly number[];
}

/** A reading older than this is "stale" (Trio greys the Live Activity out). */
export const STALE_AFTER_MS = 15 * MINUTE;
export const CHART_WINDOW_MS = 3 * 60 * MINUTE;
export const CHART_MAX_POINTS = 36;

const ARROWS: Readonly<Record<Trend, string>> = {
  doubleUp: '⇈',
  singleUp: '↑',
  fortyFiveUp: '↗',
  flat: '→',
  fortyFiveDown: '↘',
  singleDown: '↓',
  doubleDown: '⇊',
  unknown: '',
};

/** Arrow from the change per 5 minutes when the CGM reports no trend. */
export function arrowFromDelta(deltaPer5Min: number): string {
  if (deltaPer5Min >= 15) return ARROWS.doubleUp;
  if (deltaPer5Min >= 10) return ARROWS.singleUp;
  if (deltaPer5Min >= 5) return ARROWS.fortyFiveUp;
  if (deltaPer5Min > -5) return ARROWS.flat;
  if (deltaPer5Min > -10) return ARROWS.fortyFiveDown;
  if (deltaPer5Min > -15) return ARROWS.singleDown;
  return ARROWS.doubleDown;
}

export const trendArrow = (trend: Trend | undefined): string => (trend ? ARROWS[trend] : '');

/** At most `CHART_MAX_POINTS` readings of the last three hours, one per time bucket (the newest wins). */
export function chartSamples(readings: readonly GlucoseReading[], newest: number): { ages: number[]; values: number[] } {
  const inWindow = readings.filter((r) => r.value > 38 && r.date <= newest && newest - r.date < CHART_WINDOW_MS).sort((a, b) => a.date - b.date);
  const bucketMs = CHART_WINDOW_MS / CHART_MAX_POINTS;
  const picked = new Map<number, GlucoseReading>();
  for (const r of inWindow) picked.set(Math.floor((newest - r.date) / bucketMs), r);
  const samples = [...picked.values()].sort((a, b) => a.date - b.date);
  return { ages: samples.map((r) => Math.round((newest - r.date) / MINUTE)), values: samples.map((r) => Math.round(r.value)) };
}

const NO_DATA: Pick<StatusContent, 'glucose' | 'arrow' | 'delta' | 'glucoseMgdl' | 'readingAt'> = { glucose: '--', arrow: '', delta: '', glucoseMgdl: 0, readingAt: 0 };

export function buildStatusContent(input: StatusInput, settings: LiveActivitySettings): StatusContent {
  const valid = input.glucose.filter((r) => r.value > 38 && Number.isFinite(r.date));
  const last = valid.reduce<GlucoseReading | null>((best, r) => (!best || r.date > best.date ? r : best), null);
  const previous = last ? valid.filter((r) => r.date < last.date).reduce<GlucoseReading | null>((best, r) => (!best || r.date > best.date ? r : best), null) : null;

  let reading: typeof NO_DATA = NO_DATA;
  if (last) {
    // Delta per 5 minutes against the previous reading, like the home screen header.
    const minutes = previous ? Math.max(1, Math.round((last.date - previous.date) / MINUTE)) : 0;
    const deltaPer5 = previous && minutes <= 15 ? ((last.value - previous.value) / minutes) * 5 : null;
    reading = {
      glucose: formatGlucose(last.value, input.units),
      arrow: last.trend && last.trend !== 'unknown' ? trendArrow(last.trend) : deltaPer5 === null ? '' : arrowFromDelta(deltaPer5),
      delta: deltaPer5 === null ? '' : formatDelta(deltaPer5, input.units),
      glucoseMgdl: Math.round(last.value),
      readingAt: Math.floor(last.date / 1000),
    };
  }
  const chart = settings.lockScreenView === 'detailed' && settings.showChart && last ? chartSamples(valid, last.date) : { ages: [], values: [] };
  return {
    ...reading,
    unit: input.units,
    lastLoopAt: input.lastLoopAt ? Math.floor(input.lastLoopAt / 1000) : 0,
    iob: input.iob === null || !Number.isFinite(input.iob) ? '--' : input.iob.toFixed(1),
    cob: input.cob === null || !Number.isFinite(input.cob) ? '--' : String(Math.round(input.cob)),
    low: input.low,
    high: input.high,
    stale: !last || input.now - last.date > STALE_AFTER_MS,
    style: settings.lockScreenView,
    fontSize: settings.simpleFontSize,
    showIob: settings.showIob,
    showCob: settings.showCob,
    showUpdated: settings.showUpdated,
    chartAges: chart.ages,
    chartValues: chart.values,
  };
}

/** Stable key of the visible state: equal keys need no native update. */
export const contentKey = (c: StatusContent): string => JSON.stringify(c);

const clock = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export interface NotificationText {
  readonly title: string;
  readonly text: string;
  /** Epoch ms the system shows as the notification time (the reading time). */
  readonly when: number;
}

/** Android ongoing notification: glucose, trend, delta in the title; IOB, COB, last loop below. Absolute times only, so it never goes stale by itself. */
export function notificationText(c: StatusContent): NotificationText {
  const head = c.readingAt === 0 ? 'No glucose' : `${c.glucose} ${c.unit}${c.arrow ? ` ${c.arrow}` : ''}${c.delta ? `  ${c.delta}` : ''}`;
  const parts = [`IOB ${c.iob} U`, `COB ${c.cob} g`, c.lastLoopAt ? `Loop ${clock(c.lastLoopAt)}` : 'Loop not run yet'];
  return { title: c.stale && c.readingAt !== 0 ? `${head} (old)` : head, text: parts.join('  ·  '), when: c.readingAt * 1000 };
}
