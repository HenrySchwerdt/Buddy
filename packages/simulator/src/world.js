import { scheduleValueAt, trendFromRate, MINUTE, } from '@buddy/core';
import { addBolus, addMeal, glucoseMgdl, steadyState, step } from './hovorka';
import { createRng } from './random';
const CGM_INTERVAL_MIN = 5;
const SENSOR_LAG_MIN = 8;
const BOLUS_INCREMENT = 0.05;
const BASAL_INCREMENT = 0.05;
const NOISE_AR = 0.7;
/**
 * A simulated person wearing a simulated pump and CGM. Time only moves when `advance()`
 * is called, so tests and the in-app Lab run faster than real time and are reproducible.
 */
export function createVirtualWorld(o) {
    const p = o.patient.params;
    const rng = createRng(o.seed ?? 1);
    const startBasal = o.startBasal ?? scheduleValueAt(o.pumpProfile.basal, o.start);
    let state = steadyState(p, startBasal) ?? steadyState(p, 1);
    let now = o.start;
    let sensor = glucoseMgdl(p, state);
    let noise = 0;
    let temp = null;
    let suspendedUntil = null;
    const doses = [];
    const readings = [];
    const truth = [];
    let doseCounter = 0;
    let lastCgm = o.start - CGM_INTERVAL_MIN * MINUTE;
    const clock = { now: () => now };
    const id = (k) => `${k}-${doseCounter++}`;
    function currentRate(at) {
        if (suspendedUntil !== null && at < suspendedUntil)
            return 0;
        if (temp && at < temp.startedAt + temp.durationMin * MINUTE)
            return temp.rate;
        return scheduleValueAt(o.pumpProfile.basal, at, o.pumpProfile.utcOffsetMinutes);
    }
    function sampleCgm() {
        const value = glucoseMgdl(p, state);
        sensor += (value - sensor) * (1 - Math.exp(-1 / SENSOR_LAG_MIN));
        truth.push({ date: now, value });
        if (now - lastCgm >= CGM_INTERVAL_MIN * MINUTE) {
            noise = NOISE_AR * noise + Math.sqrt(1 - NOISE_AR * NOISE_AR) * rng.gaussian() * (o.cgmNoise ?? 4);
            const prev = readings.at(-1);
            const v = Math.round(Math.max(40, Math.min(400, sensor + noise)));
            const rate = prev ? (v - prev.value) / ((now - prev.date) / MINUTE) : 0;
            readings.push({ date: now, value: v, trend: trendFromRate(rate), source: 'virtual-cgm' });
            lastCgm = now;
        }
    }
    /** Moves simulated time forward minute by minute. */
    function advance(minutes) {
        for (let i = 0; i < minutes; i++) {
            const rate = currentRate(now);
            state = step(p, state, (rate * 1000) / 60, 1);
            now += MINUTE;
            if (temp && now >= temp.startedAt + temp.durationMin * MINUTE)
                temp = null;
            if (suspendedUntil !== null && now >= suspendedUntil)
                suspendedUntil = null;
            sampleCgm();
        }
    }
    const ok = (dose) => ({ ok: true, dose });
    const pump = {
        meta: { id: 'virtual-pump', name: 'Virtual Pump', manufacturer: 'Buddy', description: 'Simulated pump connected to a virtual patient.', transport: 'simulated', maturity: 'simulator' },
        connect: async () => { },
        disconnect: async () => { },
        status: async () => ({
            reservoirUnits: 200 - doses.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + d.units : s), 0),
            batteryPercent: 100,
            suspended: suspendedUntil !== null,
            tempBasal: temp ? { ...temp } : null,
            bolusing: false,
            bolusIncrement: BOLUS_INCREMENT,
            basalIncrement: BASAL_INCREMENT,
            lastSync: now,
        }),
        async setTempBasal(rate, durationMin) {
            const r = Math.max(0, Math.round(rate / BASAL_INCREMENT) * BASAL_INCREMENT);
            temp = { rate: r, startedAt: now, durationMin };
            const dose = { kind: 'tempBasal', id: id('temp'), date: now, rate: r, durationMin };
            doses.push(dose);
            return ok(dose);
        },
        async cancelTempBasal() {
            if (temp) {
                temp = null;
                // A zero-length scheduled-rate temp marks the end of the previous temp in history.
                const dose = { kind: 'tempBasal', id: id('cancel'), date: now, rate: currentRate(now), durationMin: 0 };
                doses.push(dose);
            }
            return ok();
        },
        async bolus(units, { automatic }) {
            const u = Math.floor(units / BOLUS_INCREMENT + 1e-9) * BOLUS_INCREMENT;
            if (u <= 0)
                return { ok: false, error: 'Bolus below increment' };
            state = addBolus(state, u);
            const dose = { kind: automatic ? 'smb' : 'bolus', id: id('bolus'), date: now, units: Math.round(u * 1000) / 1000 };
            doses.push(dose);
            return ok(dose);
        },
        cancelBolus: async () => ok(),
        async suspend() {
            suspendedUntil = now + 24 * 60 * MINUTE;
            doses.push({ kind: 'suspend', id: id('suspend'), date: now, durationMin: 24 * 60 });
            return ok();
        },
        async resume() {
            suspendedUntil = null;
            doses.push({ kind: 'tempBasal', id: id('resume'), date: now, rate: currentRate(now), durationMin: 0 });
            return ok();
        },
        history: async (since) => doses.filter((d) => d.date >= since),
    };
    const cgm = {
        meta: { id: 'virtual-cgm', name: 'Virtual CGM', manufacturer: 'Buddy', description: 'Simulated CGM with sensor lag and noise.', transport: 'simulated', maturity: 'simulator' },
        start: async () => { },
        stop: async () => { },
        readings: async (since) => readings.filter((r) => r.date > since),
    };
    sampleCgm();
    return {
        clock,
        pump,
        cgm,
        advance,
        /** The patient eats `grams` now (whether or not anyone logs it). */
        eat: (grams) => {
            state = addMeal(p, state, grams);
        },
        trueGlucose: () => glucoseMgdl(p, state),
        truth: () => truth,
        readings: () => readings,
        doses: () => doses,
    };
}
