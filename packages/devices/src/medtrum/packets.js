import { concatBytes } from '@buddy/core';
import { MedtrumBasePacket } from './base-packet';
import { byteAt, fromMedtrumSeconds, insulinToSteps, leUint, stepsToInsulin, toLeBytes, toMedtrumSeconds } from './bytes';
import { genKey } from './crypto';
import { CommandType, parseBasalType } from './enums';
const empty = () => new Uint8Array(0);
/** Insulin value as 2 bytes LE of 0.05 U steps (floored, see `insulinToSteps`). */
function insulinU16(amount, what) {
    const steps = insulinToSteps(amount);
    if (steps > 0xffff)
        throw new RangeError(`Medtrum: ${what} ${amount} does not fit the packet`);
    return toLeBytes(steps, 2);
}
const parseBasalResponse = (d) => ({
    basalType: parseBasalType(byteAt(d, 6)),
    basalValue: stepsToInsulin(leUint(d, 7, 2)),
    basalSequence: leUint(d, 9, 2),
    basalPatchId: leUint(d, 11, 2),
    basalStartTime: fromMedtrumSeconds(leUint(d, 13, 4)),
});
export class AuthorizePacket extends MedtrumBasePacket {
    sessionToken;
    commandType = CommandType.AUTH_REQ;
    minimumDataSize = 10;
    role = 2;
    pumpSN;
    /** `pumpSN` as stored (big-endian serial bytes, e.g. fromHex("AA76F9D9")); reversed here like the Swift original. */
    constructor(pumpSN, sessionToken) {
        super();
        this.sessionToken = sessionToken;
        this.pumpSN = pumpSN.slice().reverse();
    }
    getRequestBytes() {
        const key = genKey(this.pumpSN);
        return concatBytes(new Uint8Array([this.role]), this.sessionToken, key);
    }
    parseResponse() {
        const d = this.totalData;
        return { deviceType: byteAt(d, 7), swVersion: `${byteAt(d, 8)}.${byteAt(d, 9)}.${byteAt(d, 10)}` };
    }
}
export class SubscribePacket extends MedtrumBasePacket {
    commandType = CommandType.SUBSCRIBE;
    minimumDataSize = 0;
    getRequestBytes() {
        return toLeBytes(4095, 2);
    }
    parseResponse() {
        return {};
    }
}
// ── Time ─────────────────────────────────────────────────────────────────────
export class GetTimePacket extends MedtrumBasePacket {
    commandType = CommandType.GET_TIME;
    minimumDataSize = 10;
    getRequestBytes() {
        return empty();
    }
    parseResponse() {
        return { time: fromMedtrumSeconds(leUint(this.totalData, 6, 4)) };
    }
}
export class SetTimePacket extends MedtrumBasePacket {
    date;
    commandType = CommandType.SET_TIME;
    minimumDataSize = 0;
    constructor(date) {
        super();
        this.date = date;
    }
    getRequestBytes() {
        return concatBytes(new Uint8Array([2]), toMedtrumSeconds(this.date));
    }
    parseResponse() {
        return {};
    }
}
const HOUR_S = 3600;
export class SetTimeZonePacket extends MedtrumBasePacket {
    date;
    utcOffsetSeconds;
    commandType = CommandType.SET_TIME_ZONE;
    minimumDataSize = 0;
    /** `utcOffsetSeconds`: `TimeZone.secondsFromGMT(for: date)` of the phone's time zone at `date`. */
    constructor(date, utcOffsetSeconds) {
        super();
        this.date = date;
        this.utcOffsetSeconds = utcOffsetSeconds;
    }
    getRequestBytes() {
        let offset = this.utcOffsetSeconds;
        // Workaround for bug where it fails to set timezone > GMT + 12
        // if offset is > 12 hours, subtract 24 hours
        if (offset > 12 * HOUR_S)
            offset -= 24 * HOUR_S;
        let offsetInMinutes = Math.trunc(offset / 60);
        if (offsetInMinutes < 0)
            offsetInMinutes += 65536;
        return concatBytes(new Uint8Array([offsetInMinutes & 0xff, (offsetInMinutes >> 8) & 0xff]), toMedtrumSeconds(this.date));
    }
    parseResponse() {
        return {};
    }
}
// ── Activation ───────────────────────────────────────────────────────────────
export class PrimePacket extends MedtrumBasePacket {
    commandType = CommandType.PRIME;
    minimumDataSize = 0;
    getRequestBytes() {
        return empty();
    }
    parseResponse() {
        return {};
    }
}
export class ActivatePacket extends MedtrumBasePacket {
    o;
    commandType = CommandType.ACTIVATE;
    minimumDataSize = 25;
    autoSuspendEnable = 0;
    autoSuspendTime = 12; // unknown why this value needs to be this
    lowSuspend = 0;
    predictiveLowSuspend = 0;
    predictiveLowSuspendRange = 30; // Not sure why, but pump needs this in order to activate
    constructor(o) {
        super();
        this.o = o;
    }
    /**
     * byte 1: autoSuspendEnable -> Value for auto mode, not used for LoopKit
     * byte 2: autoSuspendTime -> Value for auto mode, not used for LoopKit
     * byte 3: expirationTimer -> Expiration timer, 0 = no expiration 1 = 12 hour reminder and expiration after 3 days
     * byte 4: alarmSetting -> see AlarmSetting
     * byte 5: lowSuspend -> Value for auto mode, not used for LoopKit
     * byte 6: predictiveLowSuspend -> Value for auto mode, not used for LoopKit
     * byte 7: predictiveLowSuspendRange -> Value for auto mode, not used for LoopKit
     * byte 8-9: hourlyMaxInsulin -> Max hourly dose of insulin, divided by 0.05
     * byte 10-11: dailyMaxSet -> Max daily dose of insulin, divided by 0.05
     * byte 12-13: tddToday -> Current TDD (of present day), divided by 0.05
     * byte 14: 1 -> Always 1
     * bytes 15 - end -> Basal profile
     */
    getRequestBytes() {
        const o = this.o;
        return concatBytes(new Uint8Array([
            this.autoSuspendEnable,
            this.autoSuspendTime,
            o.expirationTimer,
            o.alarmSetting,
            this.lowSuspend,
            this.predictiveLowSuspend,
            this.predictiveLowSuspendRange,
        ]), insulinU16(o.hourlyMaxInsulin, 'hourly max'), insulinU16(o.dailyMaxInsulin, 'daily max'), insulinU16(o.currentTDD, 'TDD'), new Uint8Array([1]), o.basalProfile);
    }
    parseResponse() {
        const d = this.totalData;
        if (d.length < 25)
            throw new RangeError('Medtrum: activate response too short');
        return {
            patchId: d.slice(6, 10),
            time: fromMedtrumSeconds(leUint(d, 10, 4)),
            basalType: parseBasalType(byteAt(d, 14)),
            basalValue: stepsToInsulin(leUint(d, 15, 2)),
            basalSequence: leUint(d, 17, 2),
            basalPatchId: leUint(d, 19, 2),
            basalStartTime: fromMedtrumSeconds(leUint(d, 21, 4)),
        };
    }
}
export class SetPatchPacket extends MedtrumBasePacket {
    o;
    commandType = CommandType.SET_PATCH;
    minimumDataSize = 0;
    autoSuspendEnable = 0;
    autoSuspendTime = 12;
    lowSuspend = 0;
    predictiveLowSuspend = 0;
    predictiveLowSuspendRange = 30;
    constructor(o) {
        super();
        this.o = o;
    }
    getRequestBytes() {
        return concatBytes(new Uint8Array([this.o.alarmSettings]), insulinU16(this.o.hourlyMaxInsulin, 'hourly max'), insulinU16(this.o.dailyMaxInsulin, 'daily max'), new Uint8Array([
            this.o.expirationTimer,
            this.autoSuspendEnable,
            this.autoSuspendTime,
            this.lowSuspend,
            this.predictiveLowSuspend,
            this.predictiveLowSuspendRange,
        ]));
    }
    parseResponse() {
        return {};
    }
}
export class StopPatchPacket extends MedtrumBasePacket {
    commandType = CommandType.STOP_PATCH;
    minimumDataSize = 10;
    getRequestBytes() {
        return empty();
    }
    parseResponse() {
        return { sequence: leUint(this.totalData, 6, 2), patchId: leUint(this.totalData, 8, 2) };
    }
}
// ── Bolus ────────────────────────────────────────────────────────────────────
export class SetBolusPacket extends MedtrumBasePacket {
    bolusAmount;
    commandType = CommandType.SET_BOLUS;
    minimumDataSize = 0;
    // Bolus types: 1 = normal, 2 = Extended, 3 = Combi
    bolusType = 1;
    constructor(bolusAmount) {
        super();
        this.bolusAmount = bolusAmount;
    }
    getRequestBytes() {
        return concatBytes(new Uint8Array([this.bolusType]), insulinU16(this.bolusAmount, 'bolus'), new Uint8Array([0]));
    }
    parseResponse() {
        return {};
    }
}
export class CancelBolusPacket extends MedtrumBasePacket {
    commandType = CommandType.CANCEL_BOLUS;
    minimumDataSize = 0;
    /**
     * 1 -> Normal bolus
     * 2 -> Extended bolus
     * 3 -> Combi bolus
     */
    bolusType = 1;
    getRequestBytes() {
        return new Uint8Array([this.bolusType]);
    }
    parseResponse() {
        return {};
    }
}
// ── Basal ────────────────────────────────────────────────────────────────────
export class SetBasalProfilePacket extends MedtrumBasePacket {
    basalProfile;
    commandType = CommandType.SET_BASAL_PROFILE;
    minimumDataSize = 17;
    basalType = 1; // Fixed to normal basal profile
    constructor(basalProfile) {
        super();
        this.basalProfile = basalProfile;
    }
    getRequestBytes() {
        return concatBytes(new Uint8Array([this.basalType]), this.basalProfile);
    }
    parseResponse() {
        return parseBasalResponse(this.totalData);
    }
}
export class SetTempBasalPacket extends MedtrumBasePacket {
    rate;
    durationMinutes;
    commandType = CommandType.SET_TEMP_BASAL;
    minimumDataSize = 17;
    type = 6; // Fixed to temp basal value for now
    /** `durationMinutes` is truncated to whole minutes like `UInt64(duration.minutes)`. */
    constructor(rate, durationMinutes) {
        super();
        this.rate = rate;
        this.durationMinutes = durationMinutes;
    }
    getRequestBytes() {
        const minutes = Math.trunc(this.durationMinutes);
        if (minutes < 0 || minutes > 0xffff)
            throw new RangeError(`Medtrum: temp basal duration ${this.durationMinutes} min`);
        return concatBytes(new Uint8Array([this.type]), insulinU16(this.rate, 'temp basal rate'), toLeBytes(minutes, 2));
    }
    parseResponse() {
        return parseBasalResponse(this.totalData);
    }
}
export class CancelTempBasalPacket extends MedtrumBasePacket {
    commandType = CommandType.CANCEL_TEMP_BASAL;
    minimumDataSize = 17;
    getRequestBytes() {
        return empty();
    }
    parseResponse() {
        return parseBasalResponse(this.totalData);
    }
}
// ── Suspend / resume / alarms ────────────────────────────────────────────────
export class SuspendPumpPacket extends MedtrumBasePacket {
    durationMinutes;
    commandType = CommandType.SUSPEND_PUMP;
    minimumDataSize = 0;
    constructor(durationMinutes) {
        super();
        this.durationMinutes = durationMinutes;
    }
    getRequestBytes() {
        const minutes = Math.trunc(this.durationMinutes);
        // Swift: UInt8(duration.minutes) traps outside 0...255
        if (minutes < 0 || minutes > 255)
            throw new RangeError(`Medtrum: suspend duration ${this.durationMinutes} min (max 255)`);
        // 3 -> cause: unknown why this is 3
        return new Uint8Array([3, minutes]);
    }
    parseResponse() {
        return {};
    }
}
export class ResumePumpPacket extends MedtrumBasePacket {
    commandType = CommandType.RESUME_PUMP;
    minimumDataSize = 0;
    getRequestBytes() {
        return empty();
    }
    parseResponse() {
        return {};
    }
}
export class ClearAlertPacket extends MedtrumBasePacket {
    alertType;
    commandType = CommandType.CLEAR_ALARM;
    minimumDataSize = 2;
    constructor(alertType) {
        super();
        this.alertType = alertType;
    }
    getRequestBytes() {
        return new Uint8Array([this.alertType & 0xff, (this.alertType >> 8) & 0xff]);
    }
    parseResponse() {
        return {};
    }
}
