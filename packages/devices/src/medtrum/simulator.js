import { concatBytes, fromHex } from '@buddy/core';
import { MEDTRUM_BASE_UNIX_SECONDS, leUint, toLeBytes } from './bytes';
import { crc8 } from './crc8';
import { genKey } from './crypto';
import { BasalType, CommandType, PatchState, patchState } from './enums';
import { MEDTRUM_READ_UUID, MEDTRUM_SERVICE_UUID, MEDTRUM_WRITE_UUID } from './link';
import { MASK_AGE, MASK_BASAL, MASK_BATTERY, MASK_NORMAL_BOLUS, MASK_RESERVOIR, MASK_SETUP, MASK_START_TIME, MASK_STORAGE, } from './notification-packet';
/** 0.05 U every 2 s = 1.5 U/min (`estimatedDuration(toBolus:)`). */
const BOLUS_STEP_MS = 2000;
const PRIME_MS = 30_000;
const RESPONSE_DELAY_MS = 1;
const medtrumSeconds = (t) => Math.max(0, Math.trunc(t / 1000 - MEDTRUM_BASE_UNIX_SECONDS));
const u16 = (v) => toLeBytes(v & 0xffff, 2);
const u32 = (v) => toLeBytes(v >>> 0, 4);
export class MedtrumPatchSimulator {
    id;
    name = 'MT';
    serviceUuids = [MEDTRUM_SERVICE_UUID];
    manufacturerData;
    mtu = 23;
    state;
    sn;
    clock;
    link = null;
    rx = null;
    boundToken = null;
    authorized = false;
    patchId;
    reservoirSteps;
    primeStartedAt = null;
    activatedAt = null;
    basal = { type: BasalType.NONE, rateSteps: 0, startTime: 0, endsAt: null };
    basalSequence = 0;
    scheduleSteps = 0;
    bolus = null;
    deliveredBolusSteps = 0;
    /** Every command the patch executed (command type), for assertions. */
    executed = [];
    /** Fault injection: answer the next command of this type with this response code. */
    rejectNext = null;
    /** Fault injection: the next write of this command type is lost before reaching the patch (link stays up). */
    loseNext = null;
    /** Model a patch that leaves the bolus field out of its status (the case MedtrumKit's checkBolusDone handles). */
    reportBolus = true;
    constructor(o) {
        this.sn = fromHex(o.serialNumber);
        this.clock = o.clock;
        this.id = o.id ?? `medtrum-${o.serialNumber}`;
        this.state = o.initialState ?? PatchState.filled;
        this.reservoirSteps = Math.round((o.reservoirUnits ?? 200) / 0.05);
        this.patchId = o.patchId ?? 41;
        // 0 & 1 -> Manufacturer ID, 2-5 -> PumpSN (little-endian), 6 -> Device type, 7 -> Version
        this.manufacturerData = concatBytes(new Uint8Array([0x5c, 0x07]), this.sn.slice().reverse(), new Uint8Array([80, 1]));
    }
    /** Ground truth: insulin the simulated patch delivered as boluses. */
    get deliveredBolusUnits() {
        return Math.round(this.deliveredBolusSteps * 5) / 100;
    }
    get isBolusing() {
        return this.bolus !== null && !this.bolus.completed;
    }
    get currentBasal() {
        return { type: this.basal.type, rate: Math.round(this.basal.rateSteps * 5) / 100 };
    }
    /** A fresh patch is filled and attached to the base (new patch id, no bound session). */
    attachNewPatch() {
        this.state = PatchState.filled;
        this.patchId += 1;
        this.boundToken = null;
        this.bolus = null;
        this.basal = { type: BasalType.NONE, rateSteps: 0, startTime: 0, endsAt: null };
        this.reservoirSteps = 4000;
    }
    /** Something other than this driver (e.g. the vendor app) cancelled the temp basal on the patch. */
    cancelTempBasalOnPatch() {
        this.setBasal(BasalType.STANDARD, this.scheduleSteps, this.clock.now(), null);
        this.notifyStatus();
    }
    /** The patch stops the running bolus on its own (e.g. occlusion, or a cancel from the vendor app). */
    stopBolusOnPatch() {
        this.tick();
        if (this.bolus)
            this.bolus.completed = true;
        this.notifyStatus();
    }
    /** A temp basal the driver does not know about (started from elsewhere). */
    startTempBasalOnPatch(rate, minutes) {
        const now = this.clock.now();
        this.setBasal(BasalType.ABSOLUTE_TEMP, Math.round(rate / 0.05), now, now + minutes * 60_000);
        this.notifyStatus();
    }
    /** An unsolicited status notification. */
    heartbeat() {
        this.tick();
        this.notifyStatus();
    }
    /** Advance the simulation to the clock's current time and notify progress. */
    tick() {
        const now = this.clock.now();
        let notify = false;
        if (this.state === PatchState.priming && this.primeStartedAt !== null && now - this.primeStartedAt >= PRIME_MS) {
            this.state = PatchState.primed;
            notify = true;
        }
        if (this.basal.endsAt !== null && now >= this.basal.endsAt && basalTypeIsTemp(this.basal.type)) {
            this.setBasal(BasalType.STANDARD, this.scheduleSteps, this.basal.endsAt, null);
            notify = true;
        }
        const b = this.bolus;
        if (b && !b.completed && patchState.isDelivering(this.state)) {
            const due = Math.min(b.requestedSteps, Math.floor((now - b.startedAt) / BOLUS_STEP_MS));
            const steps = Math.min(due - b.deliveredSteps, this.reservoirSteps);
            if (steps > 0) {
                b.deliveredSteps += steps;
                this.deliveredBolusSteps += steps;
                this.reservoirSteps -= steps;
                notify = true;
            }
            if (b.deliveredSteps >= b.requestedSteps) {
                b.completed = true;
                notify = true;
            }
        }
        if (notify)
            this.notifyStatus();
    }
    // ── FakePeripheral ─────────────────────────────────────────────────────────
    onConnect(link) {
        this.link = link;
        this.authorized = false;
        this.rx = null;
    }
    onWrite(service, characteristic, data, link) {
        this.link = link;
        if (characteristic.toLowerCase() !== MEDTRUM_WRITE_UUID)
            return;
        const content = this.reassemble(data);
        if (!content)
            return;
        const { cmd, seq, body } = content;
        if (this.loseNext === cmd) {
            this.loseNext = null;
            return;
        }
        setTimeout(() => this.respondTo(link, cmd, seq, body), RESPONSE_DELAY_MS);
    }
    /** Request framing (see base-packet.ts): validates every CRC, returns the command content once complete. */
    reassemble(data) {
        if (data.length < 5)
            throw new Error('Simulator: request fragment too short');
        const [size, cmd, seq, idx] = [data[0], data[1], data[2], data[3]];
        if (idx === 0) {
            // header + content + crc + trailing 0
            const msg = data.subarray(0, size);
            if (crc8(msg.subarray(0, size - 1)) !== msg[size - 1] || data[size] !== 0 || data.length !== size + 1) {
                throw new Error('Simulator: bad single-packet request framing');
            }
            return { cmd, seq, body: msg.subarray(4, size - 1) };
        }
        if (crc8(data.subarray(0, data.length - 1)) !== data[data.length - 1])
            throw new Error('Simulator: bad fragment CRC');
        if (idx === 1)
            this.rx = { cmd, seq, size, chunks: new Uint8Array(0) };
        if (!this.rx || this.rx.cmd !== cmd || this.rx.seq !== seq)
            throw new Error('Simulator: fragment out of order');
        this.rx.chunks = concatBytes(this.rx.chunks, data.subarray(4, data.length - 1));
        if (this.rx.chunks.length < size - 4)
            return null;
        const { chunks } = this.rx;
        this.rx = null;
        const full = concatBytes(new Uint8Array([size, cmd, seq, 0]), chunks.subarray(0, chunks.length - 1));
        if (crc8(full) !== chunks[chunks.length - 1])
            throw new Error('Simulator: bad message CRC');
        return { cmd, seq, body: full.subarray(4) };
    }
    respondTo(link, cmd, seq, body) {
        this.tick();
        const reject = this.rejectNext;
        if (reject && reject.cmd === cmd) {
            this.rejectNext = null;
            this.send(link, cmd, seq, u16(reject.code));
            return;
        }
        const result = this.execute(cmd, body);
        if (typeof result === 'number') {
            this.send(link, cmd, seq, u16(result));
            return;
        }
        this.executed.push(cmd);
        this.send(link, cmd, seq, concatBytes(u16(0), result));
        if (cmd !== CommandType.SYNCHRONIZE && cmd !== CommandType.AUTH_REQ && cmd !== CommandType.SUBSCRIBE && cmd !== CommandType.GET_TIME) {
            this.notifyStatus();
        }
    }
    /** Returns the response payload after the response code, or a non-zero response code. */
    execute(cmd, body) {
        const now = this.clock.now();
        const C = CommandType;
        if (cmd === C.AUTH_REQ)
            return this.authorize(body);
        if (!this.authorized)
            return 7;
        switch (cmd) {
            case C.SYNCHRONIZE:
                return this.statusBytes(true);
            case C.SUBSCRIBE:
            case C.SET_TIME:
            case C.SET_TIME_ZONE:
            case C.SET_PATCH:
                return new Uint8Array(0);
            case C.GET_TIME:
                return u32(medtrumSeconds(now));
            case C.PRIME:
                if (this.state !== PatchState.filled)
                    return 8;
                this.state = PatchState.priming;
                this.primeStartedAt = now;
                return new Uint8Array(0);
            case C.ACTIVATE: {
                if (!patchState.hasCompletedPriming(this.state))
                    return 8;
                const profile = body.subarray(14);
                this.scheduleSteps = profile.length >= 4 ? Math.floor(leUint(profile, 1, 3) / 4096) : 0;
                this.state = PatchState.active;
                this.activatedAt = now;
                this.setBasal(BasalType.STANDARD, this.scheduleSteps, now, null);
                return concatBytes(u32(this.patchId), u32(medtrumSeconds(now)), this.basalEcho().subarray(0));
            }
            case C.SET_BOLUS: {
                if (!patchState.isDelivering(this.state) || this.isBolusing)
                    return 8;
                const steps = leUint(body, 1, 2);
                this.bolus = { requestedSteps: steps, deliveredSteps: 0, startedAt: now, completed: steps === 0 };
                return new Uint8Array(0);
            }
            case C.CANCEL_BOLUS:
                if (this.bolus)
                    this.bolus.completed = true;
                return new Uint8Array(0);
            case C.SET_BASAL_PROFILE: {
                if (!patchState.isRunning(this.state))
                    return 8;
                this.scheduleSteps = body.length >= 5 ? Math.floor(leUint(body, 2, 3) / 4096) : 0;
                if (!basalTypeIsTemp(this.basal.type))
                    this.setBasal(BasalType.STANDARD, this.scheduleSteps, now, null);
                return this.basalEcho();
            }
            case C.SET_TEMP_BASAL: {
                if (!patchState.isDelivering(this.state))
                    return 8;
                const rate = leUint(body, 1, 2);
                const minutes = leUint(body, 3, 2);
                this.setBasal(BasalType.ABSOLUTE_TEMP, rate, now, now + minutes * 60_000);
                return this.basalEcho();
            }
            case C.CANCEL_TEMP_BASAL:
                if (!patchState.isRunning(this.state))
                    return 8;
                this.setBasal(BasalType.STANDARD, this.scheduleSteps, now, null);
                return this.basalEcho();
            case C.SUSPEND_PUMP:
                if (!patchState.isDelivering(this.state))
                    return 8;
                this.state = PatchState.suspended;
                this.setBasal(BasalType.SUSPEND_MANUAL, 0, now, null);
                return new Uint8Array(0);
            case C.RESUME_PUMP:
                if (!patchState.isRunning(this.state))
                    return 8;
                this.state = PatchState.active;
                this.setBasal(BasalType.STANDARD, this.scheduleSteps, now, null);
                return new Uint8Array(0);
            case C.CLEAR_ALARM:
                return new Uint8Array(0);
            case C.STOP_PATCH:
                this.state = PatchState.stopped;
                this.bolus = this.bolus && { ...this.bolus, completed: true };
                this.setBasal(BasalType.STOP, 0, now, null);
                return concatBytes(u16(this.basalSequence), u16(this.patchId));
            default:
                return 1;
        }
    }
    authorize(body) {
        // [role, token (4), key (4)]; an empty token makes it 5 bytes
        const key = body.subarray(body.length - 4);
        const token = Array.from(body.subarray(1, body.length - 4), (b) => b.toString(16).padStart(2, '0')).join('');
        const expectedKey = genKey(this.sn.slice().reverse());
        if (body[0] !== 2 || key.some((b, i) => b !== expectedKey[i]))
            return 7;
        if (token.length !== 8)
            return 7;
        // ASSUMPTION: a patch in setup accepts (and binds) any token; afterwards only the bound one.
        if (patchState.isSetup(this.state) && this.state !== PatchState.priming && this.state !== PatchState.primed) {
            this.boundToken = token;
        }
        else if (this.boundToken !== token) {
            return 7;
        }
        this.authorized = true;
        return new Uint8Array([0, 80, 12, 1, 3]);
    }
    setBasal(type, rateSteps, startTime, endsAt) {
        this.basal = { type, rateSteps, startTime, endsAt };
        this.basalSequence += 1;
    }
    basalEcho() {
        return concatBytes(new Uint8Array([this.basal.type]), u16(this.basal.rateSteps), u16(this.basalSequence), u16(this.patchId), u32(medtrumSeconds(this.basal.startTime)));
    }
    /** state, mask, fields (in mask order). `full` adds the slow-changing fields. */
    statusBytes(full) {
        let mask = 0;
        const fields = [];
        const now = this.clock.now();
        // ASSUMPTION: the patch reports its last bolus (with the completed flag) until a new one starts.
        if (this.bolus && this.reportBolus) {
            mask |= MASK_NORMAL_BOLUS;
            fields.push(concatBytes(new Uint8Array([1 | (this.bolus.completed ? 0x80 : 0)]), u16(this.bolus.deliveredSteps)));
        }
        if (this.basal.type !== BasalType.NONE) {
            mask |= MASK_BASAL;
            fields.push(concatBytes(new Uint8Array([this.basal.type]), u16(this.basalSequence), u16(this.patchId), u32(medtrumSeconds(this.basal.startTime)), toLeBytes(this.basal.rateSteps & 0xfff, 3)));
        }
        if (this.state === PatchState.priming || this.state === PatchState.primed) {
            mask |= MASK_SETUP;
            const progress = this.state === PatchState.primed ? 150 : Math.min(149, Math.floor(((now - (this.primeStartedAt ?? now)) / PRIME_MS) * 150));
            fields.push(new Uint8Array([progress]));
        }
        mask |= MASK_RESERVOIR;
        fields.push(u16(this.reservoirSteps));
        if (full && this.activatedAt !== null) {
            mask |= MASK_START_TIME;
            fields.push(u32(medtrumSeconds(this.activatedAt)));
        }
        if (full) {
            mask |= MASK_BATTERY | MASK_STORAGE | MASK_AGE;
            fields.push(toLeBytes(0x5a0bf0, 3));
            fields.push(concatBytes(u16(this.basalSequence), u16(this.patchId)));
            fields.push(u32(this.activatedAt === null ? 0 : Math.trunc((now - this.activatedAt) / 1000)));
        }
        return concatBytes(new Uint8Array([this.state]), u16(mask), ...fields);
    }
    notifyStatus() {
        this.link?.notify(MEDTRUM_SERVICE_UUID, MEDTRUM_READ_UUID, this.statusBytes(false));
    }
    /** Response framing, mirroring the request framing (inner CRC on fragmented answers). */
    send(link, cmd, seq, payload) {
        for (const frag of frameResponse(cmd, seq, payload))
            link.notify(MEDTRUM_SERVICE_UUID, MEDTRUM_WRITE_UUID, frag);
    }
}
const basalTypeIsTemp = (t) => t === BasalType.ABSOLUTE_TEMP || t === BasalType.RELATIVE_TEMP;
/** Frames a response (`payload` starts with the 2-byte response code). */
export function frameResponse(cmd, seq, payload) {
    if (4 + payload.length + 1 <= 20) {
        const msg = concatBytes(new Uint8Array([4 + payload.length, cmd, seq, 0]), payload);
        return [concatBytes(msg, new Uint8Array([crc8(msg)]))];
    }
    const size = 4 + payload.length + 1;
    const header = new Uint8Array([size, cmd, seq, 0]);
    const inner = concatBytes(payload, new Uint8Array([crc8(concatBytes(header, payload))]));
    const out = [];
    for (let i = 0, idx = 1; i < inner.length; i += 15, idx++) {
        const frag = concatBytes(new Uint8Array([size, cmd, seq, idx]), inner.subarray(i, i + 15));
        out.push(concatBytes(frag, new Uint8Array([crc8(frag)])));
    }
    return out;
}
