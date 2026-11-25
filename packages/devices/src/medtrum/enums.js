/**
 * TypeScript port of `MedtrumKit/Packets/CommandType.swift` and `MedtrumKit/Packets/Enums/*.swift`
 * (PatchState, BasalType, AlarmSettings, AlarmState, ClearAlarmType) from loopandlearn/MedtrumKit
 * (MIT License, (c) the original MedtrumKit authors).
 */
export const CommandType = {
    SYNCHRONIZE: 3,
    SUBSCRIBE: 4,
    AUTH_REQ: 5,
    GET_DEVICE_TYPE: 6,
    SET_TIME: 10,
    GET_TIME: 11,
    SET_TIME_ZONE: 12,
    PRIME: 16,
    ACTIVATE: 18,
    SET_BOLUS: 19,
    CANCEL_BOLUS: 20,
    SET_BASAL_PROFILE: 21,
    SET_TEMP_BASAL: 24,
    CANCEL_TEMP_BASAL: 25,
    SUSPEND_PUMP: 28,
    RESUME_PUMP: 29,
    POLL_PATCH: 30,
    STOP_PATCH: 31,
    READ_BOLUS_STATE: 34,
    SET_PATCH: 35,
    SET_BOLUS_MOTOR: 36,
    GET_RECORD: 99,
    CLEAR_ALARM: 115,
};
// ── PatchState ───────────────────────────────────────────────────────────────
export const PatchState = {
    none: 0,
    idle: 1,
    filled: 2,
    priming: 3,
    primed: 4,
    ejecting: 5,
    ejected: 6,
    active: 32,
    active_alt: 33,
    lowBgSuspended: 64,
    lowBgSuspended2: 65,
    autoSuspended: 66,
    hourlyMaxSuspended: 67,
    dailyMaxSuspended: 68,
    suspended: 69,
    paused: 70,
    occlusion: 96,
    expired: 97,
    reservoirEmpty: 98,
    patchFault: 99,
    patchFaultd2: 100,
    baseFault: 101,
    batteryOut: 102,
    noCalibration: 103,
    stopped: 128,
};
const PATCH_STATE_NAMES = new Map(Object.entries(PatchState).map(([k, v]) => [v, k]));
/** `PatchState(rawValue:) ?? .none` — an unknown byte parses to `none`. */
export const parsePatchState = (raw) => (PATCH_STATE_NAMES.has(raw) ? raw : PatchState.none);
export const patchStateName = (s) => PATCH_STATE_NAMES.get(s) ?? 'none';
const S = PatchState;
const FAULT = new Set([S.batteryOut, S.occlusion, S.patchFault, S.patchFaultd2, S.reservoirEmpty]);
const DELIVERY_HALTED = new Set([
    S.autoSuspended, S.baseFault, S.batteryOut, S.dailyMaxSuspended, S.expired, S.hourlyMaxSuspended, S.lowBgSuspended,
    S.lowBgSuspended2, S.noCalibration, S.occlusion, S.patchFault, S.patchFaultd2, S.paused, S.reservoirEmpty, S.stopped, S.suspended,
]);
const SETUP = new Set([S.ejected, S.ejecting, S.filled, S.idle, S.none, S.primed, S.priming]);
const RUNNING = new Set([
    S.active, S.active_alt, S.autoSuspended, S.dailyMaxSuspended, S.hourlyMaxSuspended, S.lowBgSuspended, S.lowBgSuspended2, S.paused, S.suspended,
]);
const SUSPENDED = new Set([
    S.autoSuspended, S.dailyMaxSuspended, S.hourlyMaxSuspended, S.lowBgSuspended, S.lowBgSuspended2, S.paused, S.suspended,
]);
export const patchState = {
    isFault: (s) => FAULT.has(s),
    isDeliveryHalted: (s) => DELIVERY_HALTED.has(s),
    phase: (s) => (SETUP.has(s) ? 'setup' : RUNNING.has(s) ? 'running' : 'terminated'),
    isSetup: (s) => SETUP.has(s),
    isRunning: (s) => RUNNING.has(s),
    isTerminated: (s) => !SETUP.has(s) && !RUNNING.has(s),
    /** Running and not suspended: on its schedule, or a temp basal */
    isDelivering: (s) => RUNNING.has(s) && !SUSPENDED.has(s),
    isSuspended: (s) => SUSPENDED.has(s),
    isBeforePriming: (s) => s === S.filled || s === S.idle || s === S.none,
    hasCompletedPriming: (s) => s === S.ejected || s === S.ejecting || s === S.primed,
    isAwaitingActivation: (s) => s !== S.none && SETUP.has(s),
};
// ── BasalType ────────────────────────────────────────────────────────────────
/** Raw values follow the Swift enum order (0 = NONE ... 41 = AUTO_MODE_EXERCISE_EXIT). */
export const BASAL_TYPE_NAMES = [
    'NONE', 'STANDARD', 'EXERCISE', 'HOLIDAY', 'PROGRAM_A', 'PROGRAM_B', 'ABSOLUTE_TEMP', 'RELATIVE_TEMP', 'PROGRAM_C', 'PROGRAM_D',
    'SICK', 'AUTO', 'NEW', 'SUSPEND_LOW_GLUCOSE', 'SUSPEND_PREDICT_LOW_GLUCOSE', 'SUSPEND_AUTO', 'SUSPEND_MORE_THAN_MAX_PER_HOUR',
    'SUSPEND_MORE_THAN_MAX_PER_DAY', 'SUSPEND_MANUAL', 'SUSPEND_KEY_LOST', 'STOP_OCCLUSION', 'STOP_EXPIRED', 'STOP_EMPTY',
    'STOP_PATCH_FAULT', 'STOP_PATCH_FAULT2', 'STOP_BASE_FAULT', 'STOP_DISCARD', 'STOP_BATTERY_EMPTY', 'STOP', 'PAUSE_INTERRUPT', 'PRIME',
    'AUTO_MODE_START', 'AUTO_MODE_EXIT', 'AUTO_MODE_TARGET_100', 'AUTO_MODE_TARGET_110', 'AUTO_MODE_TARGET_120', 'AUTO_MODE_BREAKFAST',
    'AUTO_MODE_LUNCH', 'AUTO_MODE_DINNER', 'AUTO_MODE_SNACK', 'AUTO_MODE_EXERCISE_START', 'AUTO_MODE_EXERCISE_EXIT',
];
export const BasalType = Object.fromEntries(BASAL_TYPE_NAMES.map((n, i) => [n, i]));
/** `BasalType(rawValue:) ?? .NONE` */
export const parseBasalType = (raw) => (raw >= 0 && raw < BASAL_TYPE_NAMES.length ? raw : BasalType.NONE);
export const basalTypeName = (t) => BASAL_TYPE_NAMES[t] ?? 'NONE';
const B = BasalType;
const SUSPENDED_BY_PUMP = new Set([
    B.STOP, B.STOP_BASE_FAULT, B.STOP_BATTERY_EMPTY, B.STOP_DISCARD, B.STOP_EMPTY, B.STOP_EXPIRED, B.STOP_OCCLUSION, B.STOP_PATCH_FAULT,
    B.STOP_PATCH_FAULT2, B.SUSPEND_AUTO, B.SUSPEND_KEY_LOST, B.SUSPEND_LOW_GLUCOSE, B.SUSPEND_MANUAL, B.SUSPEND_MORE_THAN_MAX_PER_DAY,
    B.SUSPEND_MORE_THAN_MAX_PER_HOUR, B.SUSPEND_PREDICT_LOW_GLUCOSE,
]);
export const basalType = {
    isTempBasal: (t) => t === B.ABSOLUTE_TEMP || t === B.RELATIVE_TEMP,
    isSuspendedByPump: (t) => SUSPENDED_BY_PUMP.has(t),
};
// ── Alarm settings / states ──────────────────────────────────────────────────
export const AlarmSettings = {
    LightVibrateAndBeep: 0,
    LightAndVibrate: 1,
    LightAndBeep: 2,
    LightOnly: 3,
    VibrateAndBeep: 4,
    VibrateOnly: 5,
    BeepOnly: 6,
    None: 7,
};
/** Only the first three flags are decoded from the notification alarm field (see NotificationPacket). */
export const AlarmState = {
    None: 0,
    PumpLowBattery: 1, // Mapped from error flag 1
    PumpLowReservoir: 2, // Mapped from error flag
    PumpExpiresSoon: 4, // Mapped from error flag 3
};
/** `AlertType` of ClearAlertPacket (ClearAlarmType in Enums): more might be possible, but unknown at this moment. */
export const ClearAlarmType = {
    hourlyMax: 4,
    daily: 5,
};
