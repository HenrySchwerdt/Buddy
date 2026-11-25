import { MedtrumBasePacket } from './base-packet';
import { byteAt, fromMedtrumSeconds, leUint, stepsToInsulin } from './bytes';
import { AlarmState, CommandType, PatchState, parseBasalType, parsePatchState } from './enums';
export const emptySyncResponse = (state, extra = {}) => ({
    state,
    activeAlarms: [],
    truncated: false,
    invalidPayload: false,
    ...extra,
});
/**
 * Rejects the whole payload (keeping only the state) when any field is out of range or belongs
 * to another patch. `expectedPatchId` 0 means "no known patch yet" (during setup).
 */
export function validated(r, expectedPatchId = 0) {
    const invalidBolus = r.bolus ? !(r.bolus.delivered >= 0 && r.bolus.delivered <= 50) : false;
    const invalidBasal = r.basal ? !(r.basal.rate >= 0 && r.basal.rate <= 40) : false;
    const invalidReservoir = r.reservoir !== undefined ? !(r.reservoir >= 0 && r.reservoir <= 400) : false;
    const wrongBasalPatch = r.basal ? expectedPatchId !== 0 && r.basal.patchId !== expectedPatchId : false;
    const wrongStoragePatch = r.storage ? expectedPatchId !== 0 && r.storage.patchId !== expectedPatchId : false;
    if (invalidBolus || invalidBasal || invalidReservoir || wrongBasalPatch || wrongStoragePatch) {
        return emptySyncResponse(r.state, { invalidPayload: true });
    }
    return r;
}
export const MASK_SUSPEND = 0x01;
export const MASK_NORMAL_BOLUS = 0x02;
export const MASK_EXTENDED_BOLUS = 0x04;
export const MASK_BASAL = 0x08;
export const MASK_SETUP = 0x10;
export const MASK_RESERVOIR = 0x20;
export const MASK_START_TIME = 0x40;
export const MASK_BATTERY = 0x80;
export const MASK_STORAGE = 0x100;
export const MASK_ALARM = 0x200;
export const MASK_AGE = 0x400;
export const MASK_MAGNETO_PLACE = 0x800;
export const MASK_UNUSED_CGM = 0x1000;
export const MASK_UNUSED_COMMAND_CONFIRM = 0x2000;
export const MASK_UNUSED_AUTO_STATUS = 0x4000;
export const MASK_UNUSED_LEGACY = 0x8000;
const FIELDS = [
    {
        mask: MASK_SUSPEND,
        size: 4,
        parse: (d, o, out) => {
            out.suspendTime = fromMedtrumSeconds(leUint(d, o, 4));
        },
    },
    {
        mask: MASK_NORMAL_BOLUS,
        size: 3,
        parse: (d, o, out) => {
            const b = byteAt(d, o);
            out.bolus = { type: b & 0x7f, completed: (b & 0x80) !== 0, delivered: stepsToInsulin(leUint(d, o + 1, 2)) };
        },
    },
    // Just ignore this flag
    { mask: MASK_EXTENDED_BOLUS, size: 3, parse: () => { } },
    {
        mask: MASK_BASAL,
        size: 12,
        parse: (d, o, out) => {
            const rateDelivery = leUint(d, o + 9, 3);
            const delivery = Math.floor(rateDelivery / 4096); // >> 12
            const rate = rateDelivery & 0x0fff;
            out.basal = {
                type: parseBasalType(byteAt(d, o)),
                sequence: leUint(d, o + 1, 2),
                patchId: leUint(d, o + 3, 2),
                startTime: fromMedtrumSeconds(leUint(d, o + 5, 4)),
                rate: stepsToInsulin(rate),
                delivery: stepsToInsulin(delivery),
            };
        },
    },
    {
        mask: MASK_SETUP,
        size: 1,
        parse: (d, o, out) => {
            out.primeProgress = byteAt(d, o);
        },
    },
    {
        mask: MASK_RESERVOIR,
        size: 2,
        parse: (d, o, out) => {
            out.reservoir = stepsToInsulin(leUint(d, o, 2));
        },
    },
    {
        mask: MASK_START_TIME,
        size: 4,
        parse: (d, o, out) => {
            out.startTime = fromMedtrumSeconds(leUint(d, o, 4));
        },
    },
    {
        mask: MASK_BATTERY,
        size: 3,
        parse: (d, o, out) => {
            const value = leUint(d, o, 3);
            out.battery = { voltageA: (value & 0x0fff) / 512, voltageB: Math.floor(value / 4096) / 512 };
        },
    },
    {
        mask: MASK_STORAGE,
        size: 4,
        parse: (d, o, out) => {
            out.storage = { sequence: leUint(d, o, 2), patchId: leUint(d, o + 2, 2) };
        },
    },
    {
        mask: MASK_ALARM,
        size: 4,
        parse: (d, o, out) => {
            const flags = leUint(d, o, 2);
            if (flags !== AlarmState.None) {
                // Alarms list available, only need to check the first 3
                for (let i = 0; i < 3; i++) {
                    if (flags & (1 << i))
                        out.activeAlarms.push((1 << i));
                }
            }
            // bytes o+2 ..< o+4: unused parameter
        },
    },
    {
        mask: MASK_AGE,
        size: 4,
        parse: (d, o, out) => {
            out.patchAge = leUint(d, o, 4);
        },
    },
    {
        mask: MASK_MAGNETO_PLACE,
        size: 2,
        parse: (d, o, out) => {
            out.magnetoPlacement = leUint(d, o, 2);
        },
    },
    { mask: MASK_UNUSED_CGM, size: 5, parse: () => { } },
    { mask: MASK_UNUSED_COMMAND_CONFIRM, size: 2, parse: () => { } },
    { mask: MASK_UNUSED_AUTO_STATUS, size: 2, parse: () => { } },
    { mask: MASK_UNUSED_LEGACY, size: 2, parse: () => { } },
];
/** Parses the field-mask payload. A payload shorter than the mask announces keeps only the state. */
export function handleSyncFields(state, fieldMask, syncData) {
    const out = { state, activeAlarms: [], truncated: false, invalidPayload: false };
    const expectedLength = FIELDS.filter((f) => (fieldMask & f.mask) !== 0).reduce((n, f) => n + f.size, 0);
    // validate the entire mask before parsing, short payload -> keep only the state
    if (syncData.length < expectedLength) {
        return { ...out, truncated: true };
    }
    let offset = 0;
    for (const field of FIELDS) {
        if ((fieldMask & field.mask) === 0)
            continue;
        if (offset + field.size > syncData.length) {
            out.truncated = true;
            break;
        }
        field.parse(syncData, offset, out);
        offset += field.size;
    }
    return validated(out);
}
/** Raw status notification (READ characteristic). Not a command response: no header, no CRC. */
export class NotificationPacket extends MedtrumBasePacket {
    commandType = CommandType.SYNCHRONIZE;
    minimumDataSize = 1;
    getRequestBytes() {
        return new Uint8Array(0);
    }
    parseResponse() {
        const d = this.totalData;
        if (d.length < this.minimumDataSize) {
            return emptySyncResponse(PatchState.none, { truncated: true });
        }
        const state = parsePatchState(d[0]);
        // a single byte is a valid state-only update, if a field mask follows, both of its bytes must be present
        if (d.length < 3) {
            return emptySyncResponse(state, { truncated: d.length === 2 });
        }
        return handleSyncFields(state, leUint(d, 1, 2), d.subarray(3));
    }
}
export class SynchronizePacket extends MedtrumBasePacket {
    commandType = CommandType.SYNCHRONIZE;
    minimumDataSize = 9;
    getRequestBytes() {
        return new Uint8Array(0);
    }
    parseResponse() {
        const d = this.totalData;
        return handleSyncFields(parsePatchState(byteAt(d, 6)), leUint(d, 7, 2), d.subarray(9));
    }
}
/** Convenience: parse a raw status notification payload. */
export function parseNotification(data) {
    const p = new NotificationPacket();
    p.totalData = data;
    return p.parseResponse();
}
