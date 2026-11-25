import { MINUTE } from './units';
/** Minutes after local midnight for `date`, honouring a fixed UTC offset. */
export function minuteOfDay(date, utcOffsetMinutes = 0) {
    const local = date + utcOffsetMinutes * MINUTE;
    const m = Math.floor(local / MINUTE) % 1440;
    return m < 0 ? m + 1440 : m;
}
export function scheduleValueAt(schedule, date, utcOffsetMinutes = 0) {
    if (schedule.length === 0)
        throw new Error('Schedule is empty');
    const m = minuteOfDay(date, utcOffsetMinutes);
    let current = schedule[0].value;
    for (const entry of schedule) {
        if (entry.startMinute <= m)
            current = entry.value;
        else
            break;
    }
    return current;
}
/** Validates a schedule: non-empty, starts at 0, strictly ascending, within a day. */
export function validateSchedule(schedule, isValid) {
    const errors = [];
    if (schedule.length === 0)
        return ['Schedule must have at least one entry'];
    if (schedule[0].startMinute !== 0)
        errors.push('Schedule must start at 00:00');
    schedule.forEach((e, i) => {
        if (e.startMinute < 0 || e.startMinute >= 1440)
            errors.push(`Entry ${i}: start out of range`);
        if (i > 0 && e.startMinute <= schedule[i - 1].startMinute)
            errors.push(`Entry ${i}: not ascending`);
        if (!isValid(e.value))
            errors.push(`Entry ${i}: invalid value`);
    });
    return errors;
}
export const constantSchedule = (value) => [{ startMinute: 0, value }];
