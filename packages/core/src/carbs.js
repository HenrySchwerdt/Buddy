import { MINUTE } from './units';
export const DEFAULT_ABSORPTION_HOURS = 3;
/** Fraction of a carb entry absorbed after `minutes` (linear model). */
export function absorbedFraction(minutes, absorptionHours) {
    if (minutes <= 0)
        return 0;
    return Math.min(1, minutes / (absorptionHours * 60));
}
export function carbsOnBoard(entries, at) {
    return entries.reduce((cob, e) => {
        const minutes = (at - e.date) / MINUTE;
        if (minutes < 0)
            return cob;
        const h = e.absorptionHours ?? DEFAULT_ABSORPTION_HOURS;
        return cob + e.grams * (1 - absorbedFraction(minutes, h));
    }, 0);
}
/** Grams absorbed in the interval (from, to]. */
export function carbsAbsorbedBetween(entries, from, to) {
    return carbsOnBoard(entries, from) - carbsOnBoard(entries, to) + entriesStartingBetween(entries, from, to);
}
function entriesStartingBetween(entries, from, to) {
    return entries.filter((e) => e.date > from && e.date <= to).reduce((s, e) => s + e.grams, 0);
}
