import { MINUTE } from './units';
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round2 = (x) => Math.round(x * 100) / 100;
/** Same windowing as oref0 `glucose-get-last.js`. Readings may be in any order. */
export function glucoseStatus(readings) {
    const sorted = [...readings].filter((r) => r.value > 38).sort((a, b) => b.date - a.date);
    const first = sorted[0];
    if (!first)
        return null;
    let nowValue = first.value;
    let nowDate = first.date;
    const last = [];
    const short = [];
    const long = [];
    for (const then of sorted.slice(1)) {
        if (then.source !== first.source)
            continue;
        const minutesAgo = Math.round((first.date - then.date) / MINUTE);
        if (minutesAgo <= 0)
            continue;
        const avgDelta = ((first.value - then.value) / minutesAgo) * 5;
        if (minutesAgo <= 2.5) {
            nowValue = (nowValue + then.value) / 2;
            nowDate = (nowDate + then.date) / 2;
        }
        else if (minutesAgo <= 17.5) {
            short.push(avgDelta);
            if (minutesAgo < 7.5)
                last.push(avgDelta);
        }
        else if (minutesAgo < 42.5) {
            long.push(avgDelta);
        }
    }
    return {
        glucose: round2(nowValue),
        date: nowDate,
        delta: round2(avg(last)),
        shortAvgDelta: round2(avg(short)),
        longAvgDelta: round2(avg(long)),
        noise: first.noise ?? 0,
        source: first.source,
    };
}
/** Dexcom-style trend arrow from a per-minute rate. */
export function trendFromRate(mgdlPerMinute) {
    if (mgdlPerMinute > 3)
        return 'doubleUp';
    if (mgdlPerMinute > 2)
        return 'singleUp';
    if (mgdlPerMinute > 1)
        return 'fortyFiveUp';
    if (mgdlPerMinute >= -1)
        return 'flat';
    if (mgdlPerMinute >= -2)
        return 'fortyFiveDown';
    if (mgdlPerMinute >= -3)
        return 'singleDown';
    return 'doubleDown';
}
export const TREND_ARROWS = {
    doubleUp: '⇈',
    singleUp: '↑',
    fortyFiveUp: '↗',
    flat: '→',
    fortyFiveDown: '↘',
    singleDown: '↓',
    doubleDown: '⇊',
    unknown: '–',
};
/** Rotation in degrees for an arrow glyph pointing right (flat = 0). */
export const TREND_ROTATION = {
    doubleUp: -90,
    singleUp: -90,
    fortyFiveUp: -45,
    flat: 0,
    fortyFiveDown: 45,
    singleDown: 90,
    doubleDown: 90,
    unknown: 0,
};
