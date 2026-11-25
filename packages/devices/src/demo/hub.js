import { HOUR, MINUTE } from '@buddy/core';
import { createVirtualWorld, findPatient, profileFor } from '@buddy/simulator';
const TICK_MS = 1000;
/**
 * Owns the virtual patient behind the demo pump and demo CGM so both see the same body.
 * Time is simulated: `clock` is what the app must use while in demo mode.
 */
export function createDemoHub() {
    let world = null;
    let options = null;
    let timer = null;
    let carry = 0;
    const listeners = new Set();
    const clock = { now: () => (world ? world.clock.now() : Date.now()) };
    function ensure(o) {
        if (world && options && options.patientId === o.patientId && options.seed === o.seed) {
            options = o;
            return world;
        }
        const patient = findPatient(o.patientId);
        const start = Date.now() - o.warmupHours * HOUR;
        world = createVirtualWorld({ patient, pumpProfile: profileFor(patient), start, seed: o.seed });
        options = o;
        warmUp(world, o.warmupHours);
        return world;
    }
    function warmUp(w, hours) {
        const mealAt = Math.max(0, hours * 60 - 150);
        for (let m = 0; m < hours * 60; m++) {
            if (m === mealAt) {
                w.eat(50);
                void w.pump.bolus(Math.round((50 / profileFor(findPatient(options.patientId)).carbRatio[0].value) * 20) / 20, { automatic: false });
            }
            w.advance(1);
        }
    }
    function start() {
        if (timer)
            return;
        timer = setInterval(() => {
            if (!world || !options)
                return;
            carry += (TICK_MS / MINUTE) * options.speed;
            const whole = Math.floor(carry);
            if (whole > 0) {
                carry -= whole;
                world.advance(whole);
                listeners.forEach((l) => l());
            }
        }, TICK_MS);
    }
    function stop() {
        if (timer)
            clearInterval(timer);
        timer = null;
    }
    return {
        clock,
        ensure,
        start,
        stop,
        world: () => world,
        /** The virtual patient eats (used when the user logs carbs in demo mode). */
        eat: (grams) => world?.eat(grams),
        onTick(l) {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        reset() {
            stop();
            world = null;
            options = null;
        },
    };
}
/** Shared hub instance used by the demo device plugins. */
export const demoHub = createDemoHub();
