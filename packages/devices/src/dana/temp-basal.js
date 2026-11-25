import { LoopTempBasalDuration } from './packets/basal';
const FLOAT_TOLERANCE = 1e-9;
/** `onboardingSupportedBolusVolumes`: 0.05 U steps from 0.05 to 30 U. */
export const BOLUS_INCREMENT = 0.05;
export const MAX_SUPPORTED_BOLUS = 30;
/** `onboardingSupportedBasalRates`: 0.01 U/h steps. */
export const BASAL_INCREMENT = 0.01;
/** The pump does not support temp basals over 500% */
export const MAX_TEMP_PERCENT = 500;
/** Temp basal >15min && >200% is not supported */
export const MAX_LONG_TEMP_PERCENT = 200;
/** Dana temp basals run at most 24 h (the hour count is a single byte; DanaKit does not check). */
export const MAX_TEMP_DURATION_MIN = 24 * 60;
const round2 = (x) => Math.round(x * 100) / 100;
/** `roundToSupportedBolusVolume(units:)` — the largest supported volume ≤ units (0 if none). */
export function roundToSupportedBolusVolume(units) {
    if (!Number.isFinite(units) || units < BOLUS_INCREMENT)
        return 0;
    const steps = Math.floor(Math.min(units, MAX_SUPPORTED_BOLUS) / BOLUS_INCREMENT + FLOAT_TOLERANCE);
    return round2(steps * BOLUS_INCREMENT);
}
/**
 * `getScheduledBasalRate`: the profile entry of the current local hour (DanaKit ignores the
 * `date` argument and always uses "now"; Buddy passes the time explicitly).
 */
export function scheduledBasalRate(basalSchedule, at) {
    if (basalSchedule.length === 0)
        return 0; // Prevent crash if basalSchedule isnt set
    return basalSchedule[new Date(at).getHours()] ?? 0;
}
/** Highest scheduled rate in the profile hours touched by [at, at + durationMin). */
export function maxScheduledBasalRate(basalSchedule, at, durationMin) {
    const startHour = new Date(at).getHours();
    const minutesIntoHour = new Date(at).getMinutes();
    const hours = Math.max(1, Math.ceil((minutesIntoHour + Math.max(0, durationMin)) / 60));
    let max = 0;
    for (let i = 0; i < Math.min(hours, 24); i++)
        max = Math.max(max, basalSchedule[(startHour + i) % 24] ?? 0);
    return max;
}
/**
 * `absoluteBasalRateToPercentage` with floor instead of round (see header). `null` = not possible.
 * The pump applies the percentage to every profile hour the temp runs through, while DanaKit
 * divides by the current hour only — a temp crossing into a higher-basal hour would then deliver
 * more than requested. Buddy divides by the highest scheduled rate in the window instead
 * (`durationMin` = 0 gives DanaKit's single-hour behaviour).
 */
export function absoluteBasalRateToPercentage(absoluteValue, basalSchedule, at, durationMin = 0) {
    if (absoluteValue === 0)
        return 0;
    if (basalSchedule.length !== 24)
        return null;
    const basalRate = maxScheduledBasalRate(basalSchedule, at, durationMin);
    // Swift divides by zero here (∞ → trap in UInt16()); refuse instead
    if (!(basalRate > 0))
        return null;
    return Math.floor((absoluteValue / basalRate) * 100 + FLOAT_TOLERANCE);
}
/** `isSupportedDuration` (minutes instead of seconds). */
export const isSupportedDuration = (durationMin) => durationMin === 0 || durationMin === 15 || durationMin === 30 || durationMin % 60 === 0;
/**
 * The duration/percentage part of `_enactTempBasal` for a non-zero duration:
 * "There are 2 ways to set a temp basal: the normal way (which only accepts full hours and
 * percentages) and a short APS-special temp basal command (which only accepts 15 min or 30 min).
 * A temp basal >200% for 30 min (or full hour) is rescheduled to 15min."
 */
export function planTempBasal(percentage, requestedDurationMin) {
    if (!Number.isFinite(requestedDurationMin) || requestedDurationMin <= 0)
        return { ok: false, error: 'Temp basal duration must be positive' };
    if (requestedDurationMin > MAX_TEMP_DURATION_MIN)
        return { ok: false, error: `Temp basal longer than ${MAX_TEMP_DURATION_MIN / 60} h is unsupported` };
    // Check if duration is supported
    // If not, round it down to nearest supported duration
    let duration = requestedDurationMin;
    if (!isSupportedDuration(duration)) {
        if (duration > 60) {
            // Round down to nearest full hour
            duration = 60 * Math.floor(duration / 60);
        }
        else if (duration > 30) {
            // Round down to 30 min
            duration = 30;
        }
        else if (duration > 15) {
            // Round down to 15 min
            duration = 15;
        }
        else {
            return { ok: false, error: 'Temp basal below 15 min is unsupported... (floor duration)' };
        }
    }
    // Temp basal >15min && >200% is not supported
    // Floor it down to 15min
    if (percentage > MAX_LONG_TEMP_PERCENT && duration !== 15) {
        duration = 15;
    }
    // The pump does not support temp basals over 500%
    const percent = Math.min(percentage, MAX_TEMP_PERCENT);
    if (duration === 15)
        return { ok: true, percent, durationMin: 15, command: { kind: 'short', code: LoopTempBasalDuration.min15 } };
    if (duration === 30)
        return { ok: true, percent, durationMin: 30, command: { kind: 'short', code: LoopTempBasalDuration.min30 } };
    return { ok: true, percent, durationMin: duration, command: { kind: 'hours', hours: Math.floor(duration / 60) } };
}
/**
 * What the pump actually runs: it applies the percentage to each profile hour's own scheduled rate,
 * so a temp is split at every local-hour boundary where that absolute rate changes (adjacent
 * hours with equal rates are merged).
 */
export function splitTempAtHours(percent, basalSchedule, at, durationMin) {
    const end = at + durationMin * 60_000;
    const segments = [];
    let cursor = at;
    while (cursor < end) {
        const boundary = new Date(cursor);
        boundary.setHours(boundary.getHours() + 1, 0, 0, 0);
        const segEnd = Math.min(boundary.getTime(), end);
        const rate = percentToRate(percent, scheduledBasalRate(basalSchedule, cursor));
        const last = segments[segments.length - 1];
        if (last && last.rate === rate)
            segments[segments.length - 1] = { ...last, durationMin: (segEnd - last.date) / 60_000 };
        else
            segments.push({ date: cursor, durationMin: (segEnd - cursor) / 60_000, rate });
        cursor = segEnd;
    }
    return segments;
}
/** `((Double(percentage) / 100) * scheduledBasal).rounded(toPlaces: 2)` */
export const percentToRate = (percent, scheduledBasal) => round2((percent / 100) * scheduledBasal);
