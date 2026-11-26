import type { CarbEntry, Millis } from './types';
import { MINUTE } from './units';

export const DEFAULT_ABSORPTION_HOURS = 3;

let maxAbsorptionHours = Infinity;

/**
 * Upper limit for any entry's absorption time (Trio's `maxMealAbsorptionTime`, hours). The app sets
 * it from the Meal Settings; non-positive or non-finite values remove the limit.
 */
export function setMaxAbsorptionHours(hours: number): void {
  maxAbsorptionHours = Number.isFinite(hours) && hours > 0 ? hours : Infinity;
}

/** Absorption time of an entry in hours, limited by the configured maximum. */
export function absorptionHoursOf(e: { readonly absorptionHours?: number }): number {
  return Math.min(e.absorptionHours ?? DEFAULT_ABSORPTION_HOURS, maxAbsorptionHours);
}

/** Fraction of a carb entry absorbed after `minutes` (linear model). */
export function absorbedFraction(minutes: number, absorptionHours: number): number {
  if (minutes <= 0) return 0;
  return Math.min(1, minutes / (absorptionHours * 60));
}

export function carbsOnBoard(entries: readonly CarbEntry[], at: Millis): number {
  return entries.reduce((cob, e) => {
    const minutes = (at - e.date) / MINUTE;
    if (minutes < 0) return cob;
    const h = absorptionHoursOf(e);
    return cob + e.grams * (1 - absorbedFraction(minutes, h));
  }, 0);
}

/** Grams absorbed in the interval (from, to]. */
export function carbsAbsorbedBetween(entries: readonly CarbEntry[], from: Millis, to: Millis): number {
  return carbsOnBoard(entries, from) - carbsOnBoard(entries, to) + entriesStartingBetween(entries, from, to);
}

function entriesStartingBetween(entries: readonly CarbEntry[], from: Millis, to: Millis): number {
  return entries.filter((e) => e.date > from && e.date <= to).reduce((s, e) => s + e.grams, 0);
}
