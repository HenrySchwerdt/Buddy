import { isOverrideActive } from './adjustments';
import { carbsOnBoard } from './carbs';
import { glucoseStatus } from './glucose';
import { computeIob } from './insulin';
import { guardDecision } from './safety';
import { HOUR, MINUTE } from './units';
const HISTORY_WINDOW = 24 * HOUR;
/** Skip a temp basal command if the running temp already matches within this tolerance. */
const TEMP_MATCH_TOLERANCE = 0.001;
const TEMP_MIN_REMAINING_MIN = 10;
/**
 * Orchestrates one loop cycle: sync devices → build input → algorithm → SafetyGuard → enact.
 * The engine is the only component allowed to command insulin.
 */
export function createLoopEngine(deps) {
    let running = false;
    async function sync(now) {
        const snap = deps.store.snapshot();
        const lastGlucose = snap.glucose.at(-1)?.date ?? now - HISTORY_WINDOW;
        deps.store.addGlucose(await deps.cgm.readings(lastGlucose));
        deps.store.addDoses(await deps.pump.history(now - HISTORY_WINDOW));
        if (deps.pump.carbHistory)
            for (const c of await deps.pump.carbHistory(now - HISTORY_WINDOW))
                deps.store.addCarbs(c);
    }
    async function enact(decision, input) {
        const enacted = {};
        const current = input.pump.tempBasal;
        const remaining = current ? current.startedAt + current.durationMin * MINUTE - input.now : 0;
        if (decision.tempBasal === null) {
            if (current && remaining > 0) {
                const r = await deps.pump.cancelTempBasal();
                if (!r.ok)
                    throw new Error(`Cancel temp failed: ${r.error}`);
                enacted.tempBasal = null;
            }
        }
        else if (decision.tempBasal) {
            const same = current &&
                Math.abs(current.rate - decision.tempBasal.rate) < TEMP_MATCH_TOLERANCE &&
                remaining > TEMP_MIN_REMAINING_MIN * MINUTE;
            if (!same) {
                const r = await deps.pump.setTempBasal(decision.tempBasal.rate, decision.tempBasal.durationMin);
                if (!r.ok)
                    throw new Error(`Set temp failed: ${r.error}`);
                enacted.tempBasal = decision.tempBasal;
            }
        }
        if (decision.autoBolus && decision.autoBolus > 0) {
            const r = await deps.pump.bolus(decision.autoBolus, { automatic: true });
            if (!r.ok)
                throw new Error(`Automatic bolus failed: ${r.error}`);
            enacted.autoBolus = decision.autoBolus;
        }
        return enacted;
    }
    async function runOnce() {
        const started = Date.now();
        const now = deps.clock.now();
        const config = deps.config();
        const base = {
            date: now,
            mode: config.mode,
            algorithmId: config.algorithm.meta.id,
            suggested: null,
            guarded: null,
            interventions: [],
            enacted: null,
        };
        const finish = (run) => {
            const full = { ...run, durationMs: Date.now() - started };
            deps.store.addLoopRun(full);
            return full;
        };
        try {
            await sync(now);
            const snap = deps.store.snapshot();
            const since = now - HISTORY_WINDOW;
            const glucose = snap.glucose.filter((g) => g.date >= since && g.date <= now).slice().reverse();
            const status = glucoseStatus(glucose);
            const doses = snap.doses.filter((d) => d.date >= since);
            const carbs = snap.carbs.filter((c) => c.date >= since && c.date <= now);
            const iob = computeIob(doses, config.profile, now);
            const cob = carbsOnBoard(carbs, now);
            if (!status)
                return finish({ ...base, glucose: null, iob: iob.iob, cob, error: 'No glucose data' });
            const input = {
                now,
                glucose,
                glucoseStatus: status,
                doses,
                carbs,
                profile: config.profile,
                limits: config.limits,
                pump: await deps.pump.status(),
                iob,
                cob,
                // A scheduled temp target only applies between its start and end.
                tempTarget: config.tempTarget && config.tempTarget.endsAt > now && (config.tempTarget.startsAt ?? 0) <= now ? config.tempTarget : undefined,
                override: isOverrideActive(config.override, now) ? config.override : undefined,
            };
            const suggested = config.algorithm.decide(input, config.algorithmSettings);
            const { decision, interventions } = guardDecision(input, suggested);
            const closed = config.mode === 'closed' && !deps.pump.meta.readOnly;
            const enacted = closed ? await enact(decision, input) : null;
            if (enacted)
                deps.store.addDoses(await deps.pump.history(now - HOUR));
            const reference = deps.pump.referenceDecision ? await deps.pump.referenceDecision(now).catch(() => null) : undefined;
            return finish({ ...base, mode: closed ? 'closed' : 'open', glucose: status.glucose, iob: iob.iob, cob, suggested, guarded: decision, interventions, enacted, reference });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            deps.log.error(`Loop failed: ${message}`);
            return finish({ ...base, glucose: null, iob: 0, cob: 0, error: message });
        }
    }
    return {
        /** Runs one cycle; concurrent calls are rejected so two cycles never overlap. */
        async run() {
            if (running)
                return null;
            running = true;
            try {
                return await runOnce();
            }
            finally {
                running = false;
            }
        },
    };
}
