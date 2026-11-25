import { concatBytes } from '@buddy/core';
import { insulinToSteps, toLeBytes } from './bytes';
/** MedtrumPumpManager.onboardingMaximumBasalScheduleEntryCount */
export const MAX_BASAL_SCHEDULE_ENTRIES = 48;
/** MedtrumPumpManager.minimumBasalScheduleEntryDuration (30 min) */
export const BASAL_SCHEDULE_GRANULARITY_MIN = 30;
/** Validates a Buddy basal schedule (U/h) for the Nano. Returns a list of problems (empty = ok). */
export function validateBasalSchedule(schedule, maxRate) {
    const errors = [];
    if (schedule.length === 0)
        errors.push('Basal schedule is empty');
    if (schedule.length > MAX_BASAL_SCHEDULE_ENTRIES)
        errors.push(`At most ${MAX_BASAL_SCHEDULE_ENTRIES} basal entries are supported`);
    if (schedule[0] && schedule[0].startMinute !== 0)
        errors.push('First basal entry must start at midnight');
    schedule.forEach((e, i) => {
        if (!Number.isInteger(e.startMinute) || e.startMinute < 0 || e.startMinute >= 24 * 60)
            errors.push(`Entry ${i}: invalid start ${e.startMinute}`);
        if (e.startMinute % BASAL_SCHEDULE_GRANULARITY_MIN !== 0)
            errors.push(`Entry ${i}: start must be a multiple of 30 minutes`);
        if (i > 0 && e.startMinute <= schedule[i - 1].startMinute)
            errors.push(`Entry ${i}: entries must be sorted and unique`);
        if (!Number.isFinite(e.value) || e.value < 0 || e.value > maxRate)
            errors.push(`Entry ${i}: rate ${e.value} U/h outside 0–${maxRate}`);
    });
    return errors;
}
/** `BasalSchedule.toData()` */
export function basalScheduleToBytes(schedule) {
    const entries = schedule.map((item) => {
        const rate = insulinToSteps(item.value);
        const time = Math.trunc(item.startMinute);
        if (time > 0xfff || rate > 0xfff || time < 0) {
            throw new RangeError(`Rate or time is too big: ${rate}, ${time}`);
        }
        return toLeBytes(rate * 4096 + time, 3);
    });
    return concatBytes(new Uint8Array([schedule.length]), ...entries);
}
/** Scheduled rate at `minuteOfDay` (`currentBaseBasalRate`). */
export function scheduledRateAt(schedule, minuteOfDay) {
    let rate = 0;
    for (const e of schedule)
        if (e.startMinute <= minuteOfDay)
            rate = e.value;
    return rate;
}
