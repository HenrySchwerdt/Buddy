/** `enteredBy` / `device` value on everything Buddy uploads (Trio uses "Trio"). */
export const ENTERED_BY = 'Buddy';
/** Trio's `customISO8601` encoding: ISO 8601 with milliseconds, UTC. */
export const isoDate = (date) => new Date(date).toISOString();
/** Rounds to `places` decimals, avoiding binary float noise such as 0.30000000000000004 in JSON. */
export const round = (value, places) => {
    const f = 10 ** places;
    return Math.round(value * f) / f;
};
const DIRECTIONS = {
    doubleUp: 'DoubleUp',
    singleUp: 'SingleUp',
    fortyFiveUp: 'FortyFiveUp',
    flat: 'Flat',
    fortyFiveDown: 'FortyFiveDown',
    singleDown: 'SingleDown',
    doubleDown: 'DoubleDown',
    unknown: 'NONE',
};
/** Nightscout `direction` string for a Buddy trend (Trio's `BloodGlucose.Direction` raw values). */
export const directionOf = (trend) => DIRECTIONS[trend];
/** Sources whose data came *from* Nightscout and must never be uploaded back. */
const NIGHTSCOUT_SOURCE = 'nightscout';
/** Id prefix the Nightscout follower gives doses/carbs it read from Nightscout (`ns-bolus-…`). */
const NIGHTSCOUT_ID_PREFIX = 'ns-';
export const isNightscoutSource = (source) => source === NIGHTSCOUT_SOURCE || source.startsWith(`${NIGHTSCOUT_SOURCE}-`);
export const isNightscoutId = (id) => id.startsWith(NIGHTSCOUT_ID_PREFIX);
