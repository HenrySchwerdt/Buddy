import { scheduleValueAt } from './schedule';
import { MINUTE } from './units';
export const DEFAULT_PEAK_MINUTES = {
    'rapid-acting': 75,
    'ultra-rapid': 55,
};
export function insulinModelFor(profile) {
    return {
        diaMinutes: Math.max(5, profile.diaHours) * 60,
        peakMinutes: profile.insulinPeakMinutes ?? DEFAULT_PEAK_MINUTES[profile.insulinCurve],
    };
}
/**
 * Exponential insulin curve as used by oref0 / Loop (Dragan Maksimovic's formulation).
 * Returns the fraction of a 1 U dose still on board and the activity (U/min) at
 * `minutes` after delivery.
 */
export function exponentialCurve(model, minutes) {
    const td = model.diaMinutes;
    const tp = model.peakMinutes;
    const t = minutes;
    if (t < 0)
        return { iob: 1, activity: 0 };
    if (t >= td)
        return { iob: 0, activity: 0 };
    const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
    const a = (2 * tau) / td;
    const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
    const activity = (S / (tau * tau)) * t * (1 - t / td) * Math.exp(-t / tau);
    const iob = 1 - S * (1 - a) * ((t * t / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);
    return { iob: Math.max(0, iob), activity: Math.max(0, activity) };
}
const BASAL_CHUNK_MIN = 5;
/**
 * Converts dose history into discrete pulses of *net* insulin relative to the profile's
 * scheduled basal. Temp basals and suspends are truncated by the next basal event and by `now`.
 */
export function toNetPulses(doses, profile, now) {
    const sorted = [...doses].sort((a, b) => a.date - b.date);
    const basalEvents = sorted.filter((d) => d.kind === 'tempBasal' || d.kind === 'suspend');
    const pulses = [];
    for (const dose of sorted) {
        if (dose.date > now)
            continue;
        if (dose.kind === 'bolus' || dose.kind === 'smb') {
            pulses.push({ date: dose.date, units: dose.units, isBasal: false });
            continue;
        }
        if (dose.kind !== 'tempBasal' && dose.kind !== 'suspend')
            continue;
        const next = basalEvents.find((e) => e.date > dose.date);
        const end = Math.min(dose.date + dose.durationMin * MINUTE, next ? next.date : Infinity, now);
        for (let t = dose.date; t < end; t += BASAL_CHUNK_MIN * MINUTE) {
            const chunkEnd = Math.min(t + BASAL_CHUNK_MIN * MINUTE, end);
            const hours = (chunkEnd - t) / (60 * MINUTE);
            const scheduled = scheduleValueAt(profile.basal, t, profile.utcOffsetMinutes);
            const rate = dose.kind === 'tempBasal' ? dose.rate : 0;
            const net = (rate - scheduled) * hours;
            if (net !== 0)
                pulses.push({ date: t, units: net, isBasal: true });
        }
    }
    return pulses;
}
export function iobFromPulses(pulses, model, at) {
    let bolusIob = 0;
    let basalIob = 0;
    let activity = 0;
    for (const p of pulses) {
        const minutes = (at - p.date) / MINUTE;
        if (minutes < 0 || minutes >= model.diaMinutes)
            continue;
        const c = exponentialCurve(model, minutes);
        if (p.isBasal)
            basalIob += p.units * c.iob;
        else
            bolusIob += p.units * c.iob;
        activity += p.units * c.activity;
    }
    return { date: at, iob: bolusIob + basalIob, bolusIob, basalIob, activity };
}
export function computeIob(doses, profile, at) {
    return iobFromPulses(toNetPulses(doses, profile, at), insulinModelFor(profile), at);
}
/**
 * IOB projected forward every 5 minutes assuming no further deviation from scheduled basal.
 * With `zeroTempFromNow` an additional zero temp is assumed from `now` (oref's iobWithZeroTemp).
 */
export function projectIob(doses, profile, now, horizonMinutes, zeroTempFromNow = false) {
    const model = insulinModelFor(profile);
    const pulses = toNetPulses(doses, profile, now);
    const extra = [];
    if (zeroTempFromNow) {
        for (let t = now; t < now + horizonMinutes * MINUTE; t += BASAL_CHUNK_MIN * MINUTE) {
            const scheduled = scheduleValueAt(profile.basal, t, profile.utcOffsetMinutes);
            extra.push({ date: t, units: (-scheduled * BASAL_CHUNK_MIN) / 60, isBasal: true });
        }
    }
    const out = [];
    for (let m = 0; m <= horizonMinutes; m += 5) {
        const at = now + m * MINUTE;
        const visibleExtra = extra.filter((p) => p.date <= at);
        out.push(iobFromPulses([...pulses, ...visibleExtra], model, at));
    }
    return out;
}
/** Total insulin delivered (absolute, not net) in [from, to). */
export function totalDelivered(doses, from, to) {
    const sorted = [...doses].sort((a, b) => a.date - b.date);
    const basalEvents = sorted.filter((d) => d.kind === 'tempBasal' || d.kind === 'suspend');
    let total = 0;
    for (const d of sorted) {
        if (d.kind === 'bolus' || d.kind === 'smb') {
            if (d.date >= from && d.date < to)
                total += d.units;
        }
        else if (d.kind === 'tempBasal') {
            const next = basalEvents.find((e) => e.date > d.date);
            const start = Math.max(d.date, from);
            const end = Math.min(d.date + d.durationMin * MINUTE, next ? next.date : Infinity, to);
            if (end > start)
                total += (d.rate * (end - start)) / (60 * MINUTE);
        }
    }
    return total;
}
