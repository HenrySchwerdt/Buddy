import { ENTERED_BY, directionOf, isNightscoutSource, isoDate } from './format';
export function mapGlucoseToEntry(r) {
    return {
        type: 'sgv',
        sgv: Math.round(r.value),
        ...(r.trend ? { direction: directionOf(r.trend) } : {}),
        date: Math.round(r.date),
        dateString: isoDate(r.date),
        ...(r.noise !== undefined ? { noise: r.noise } : {}),
        device: ENTERED_BY,
        identifier: `${r.source}-${Math.round(r.date)}`,
    };
}
/** Readings that came from a Nightscout CGM source are skipped so they never loop back. */
export const mapGlucoseToEntries = (readings) => readings.filter((r) => !isNightscoutSource(r.source) && Number.isFinite(r.value) && r.value > 0).map(mapGlucoseToEntry);
