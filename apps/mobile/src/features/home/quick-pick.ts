/** Port of HomeStateModel+QuickPickTreatments.swift: scoring of past manual boluses and carb entries. */

export interface QuickPickSample {
  readonly amount: number;
  readonly timestamp: number;
}

const SIGMA = 60;
const HALF_LIFE_DAYS = 10;
const MIN_SCORE = 0.1;
export const LOOKBACK_DAYS = 90;
export const DISPLAY_LIMIT = 3;

type Rounding = 'plain' | 'down';

function roundTo(v: number, scale: number, mode: Rounding): number {
  const f = 10 ** scale;
  // tiny epsilon: 1.15 * 10 is 11.499999999999998 in floating point
  const scaled = v * f + 1e-9;
  return (mode === 'down' ? Math.floor(scaled) : Math.round(scaled)) / f;
}

/** Scores samples by recency, time of day and weekday/weekend similarity to `now`; returns the best rounded amounts. */
export function topQuickPickSuggestions(samples: readonly QuickPickSample[], roundingScale: number, now: number, roundingMode: Rounding = 'plain', limit = 5): number[] {
  const n = new Date(now);
  const nowMinute = n.getHours() * 60 + n.getMinutes();
  const nowDow = n.getDay();
  const groups = new Map<number, number>();
  for (const s of samples) {
    const key = roundTo(s.amount, roundingScale, roundingMode);
    const e = new Date(s.timestamp);
    const diff = Math.abs(e.getHours() * 60 + e.getMinutes() - nowMinute);
    const circular = Math.min(diff, 1440 - diff);
    const t = Math.exp(-(circular * circular) / (2 * SIGMA * SIGMA));
    const entryDow = e.getDay();
    const isWeekend = (d: number) => d === 0 || d === 6;
    const d = entryDow === nowDow ? 1 : isWeekend(nowDow) === isWeekend(entryDow) ? 0.7 : 0.15;
    const daysAgo = (now - s.timestamp) / 86_400_000;
    const r = 0.5 ** (daysAgo / HALF_LIFE_DAYS);
    groups.set(key, (groups.get(key) ?? 0) + t * d * r);
  }
  return [...groups.entries()]
    .filter(([key, score]) => key > 0 && score >= MIN_SCORE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

/** displayedSuggestions: top `limit`, de-duplicated, ascending. */
export function displayedSuggestions(suggestions: readonly number[], limit = DISPLAY_LIMIT): number[] {
  return [...new Set(suggestions.slice(0, limit))].sort((a, b) => a - b);
}

export interface QuickPickHistory {
  readonly boluses: readonly QuickPickSample[];
  readonly carbs: readonly QuickPickSample[];
}

/** Bolus amounts floor to 0.1 U and respect Max Bolus; carbs round to grams and respect Max Carbs. */
export function quickPickSuggestions(h: QuickPickHistory, limits: { maxBolus: number; maxCarbs: number }, now: number) {
  const cutoff = now - LOOKBACK_DAYS * 86_400_000;
  const boluses = h.boluses.filter((s) => s.timestamp >= cutoff && s.amount > 0 && s.amount <= limits.maxBolus);
  const carbs = h.carbs.filter((s) => s.timestamp >= cutoff && s.amount > 0 && s.amount <= limits.maxCarbs);
  return {
    bolus: topQuickPickSuggestions(boluses, 1, now, 'down'),
    carbs: topQuickPickSuggestions(carbs, 0, now),
  };
}

export function slideLabel(bolus: number | null, carbs: number | null): string {
  if (bolus !== null && carbs !== null) return 'Slide to Log and Enact';
  if (bolus !== null) return 'Slide to Enact';
  if (carbs !== null) return 'Slide to Log';
  return 'Slide to Confirm';
}

export interface QuickPickOutcome {
  readonly carbs: 'succeeded' | 'failed' | null;
  readonly bolus: 'succeeded' | 'failed' | null;
  readonly bolusFailureMessage?: string | null;
}

export interface OutcomeAlert {
  readonly title: string;
  readonly message: string;
  /** Close the sheet once acknowledged; false when the user can still retry. */
  readonly dismissesSheet: boolean;
}

/** QuickPickTreatmentsView.handle: null means everything requested went through (sheet closes silently). */
export function outcomeAlert(o: QuickPickOutcome): OutcomeAlert | null {
  const { carbs, bolus } = o;
  if (carbs !== 'failed' && bolus !== 'failed') return null;
  if (carbs === 'succeeded' && bolus === 'failed') {
    return {
      title: 'Bolus Not Enacted',
      message: o.bolusFailureMessage ? `Carbs were logged. ${o.bolusFailureMessage}` : 'Carbs were logged, but the bolus was not enacted.',
      dismissesSheet: true,
    };
  }
  if (carbs === 'failed' && bolus === 'succeeded') {
    return { title: 'Carbs Not Logged', message: 'The bolus was enacted, but the carbs could not be logged. Please log them manually.', dismissesSheet: true };
  }
  if (carbs === 'failed' && bolus === 'failed') {
    return { title: 'Nothing Was Saved', message: 'Neither the carbs nor the bolus could be saved. Please try again.', dismissesSheet: false };
  }
  if (bolus === 'failed') return { title: 'Bolus Not Enacted', message: o.bolusFailureMessage ?? 'The bolus was not enacted.', dismissesSheet: false };
  return { title: 'Carbs Not Logged', message: 'The carbs could not be logged. Please try again.', dismissesSheet: false };
}
