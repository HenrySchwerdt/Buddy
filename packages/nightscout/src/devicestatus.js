import { ENTERED_BY, isoDate, round } from './format';
const DEFAULT_VERSION = 'Unknown';
const INSULIN_PLACES = 3;
const RATE_PLACES = 3;
const roundSeries = (s) => (s && s.length > 0 ? s.map((v) => Math.round(v)) : undefined);
/** oref `predBGs` (integer mg/dL). A single generic `main` line is shown as the IOB line. */
function predBGs(p) {
    if (!p)
        return undefined;
    const out = {
        IOB: roundSeries(p.iob ?? p.main),
        ZT: roundSeries(p.zt),
        COB: roundSeries(p.cob),
        UAM: roundSeries(p.uam),
    };
    const present = Object.entries(out).filter(([, v]) => v !== undefined);
    return present.length > 0 ? Object.fromEntries(present) : undefined;
}
/** `null` temp (cancel) is oref's rate 0 / duration 0. */
function tempFields(temp) {
    if (temp === undefined)
        return {};
    if (temp === null)
        return { rate: 0, duration: 0 };
    return { rate: round(temp.rate, RATE_PLACES), duration: Math.round(temp.durationMin) };
}
const opt = (key, value) => value === undefined || value === null ? {} : { [key]: value };
function reasonOf(run, decision) {
    if (run.interventions.length === 0)
        return decision.reason;
    return `${decision.reason}; Safety: ${run.interventions.map((i) => i.message).join('; ')}`;
}
function determination(run, decision) {
    const at = isoDate(run.date);
    return {
        reason: reasonOf(run, decision),
        timestamp: at,
        deliverAt: at,
        ...opt('bg', run.glucose === null ? undefined : Math.round(run.glucose)),
        IOB: round(run.iob, INSULIN_PLACES),
        COB: Math.round(run.cob),
        ...opt('eventualBG', decision.eventualGlucose === undefined ? undefined : Math.round(decision.eventualGlucose)),
        ...opt('insulinReq', decision.insulinReq === undefined ? undefined : round(decision.insulinReq, INSULIN_PLACES)),
        ...opt('carbsReq', decision.carbsReq === undefined ? undefined : Math.round(decision.carbsReq)),
        ...opt('sensitivityRatio', decision.sensitivityRatio),
        ...opt('predBGs', predBGs(decision.predictions)),
    };
}
/**
 * `suggested` is what the loop would do after the SafetyGuard (the guarded decision); `enacted`
 * is present only when the pump confirmed a command in this run, like oref's `received: true`.
 */
function suggestedOf(run) {
    const decision = run.guarded ?? run.suggested;
    if (!decision)
        return undefined;
    return {
        ...determination(run, decision),
        ...tempFields(decision.tempBasal),
        ...opt('units', decision.autoBolus && decision.autoBolus > 0 ? round(decision.autoBolus, INSULIN_PLACES) : undefined),
    };
}
function enactedOf(run) {
    const enacted = run.enacted;
    const decision = run.guarded ?? run.suggested;
    if (!enacted || !decision)
        return undefined;
    const hasTemp = enacted.tempBasal !== undefined;
    const hasBolus = enacted.autoBolus !== undefined && enacted.autoBolus > 0;
    if (!hasTemp && !hasBolus)
        return undefined;
    return {
        ...determination(run, decision),
        ...tempFields(enacted.tempBasal),
        ...opt('units', hasBolus ? round(enacted.autoBolus, INSULIN_PLACES) : undefined),
        received: true,
    };
}
function pumpOf(pump) {
    const status = pump.suspended ? 'suspended' : pump.bolusing ? 'bolusing' : 'normal';
    return {
        clock: isoDate(pump.lastSync),
        ...opt('reservoir', pump.reservoirUnits === null ? undefined : round(pump.reservoirUnits, 2)),
        ...opt('battery', pump.batteryPercent === null ? undefined : { percent: Math.round(pump.batteryPercent) }),
        status: { status, bolusing: pump.bolusing, suspended: pump.suspended, timestamp: isoDate(pump.lastSync) },
        bolusIncrement: pump.bolusIncrement,
    };
}
/** Maps one loop cycle plus the current pump state to a Trio-shaped Nightscout devicestatus. */
export function mapLoopRunToDeviceStatus(run, pump, opts = {}) {
    const at = isoDate(run.date);
    return {
        device: ENTERED_BY,
        created_at: at,
        openaps: {
            iob: { iob: round(run.iob, INSULIN_PLACES), time: at },
            ...opt('suggested', suggestedOf(run)),
            ...opt('enacted', enactedOf(run)),
            version: opts.version ?? DEFAULT_VERSION,
            dosingMode: run.mode,
        },
        ...opt('pump', pump ? pumpOf(pump) : undefined),
        ...opt('uploader', opts.uploaderBattery === undefined
            ? undefined
            : { battery: Math.round(opts.uploaderBattery), ...opt('isCharging', opts.isCharging) }),
    };
}
