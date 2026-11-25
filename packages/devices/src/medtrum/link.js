import { hex } from '@buddy/core';
import { NotificationPacket } from './notification-packet';
export const MEDTRUM_SERVICE_UUID = '669a9001-0008-968f-e311-6050405558b3';
export const MEDTRUM_READ_UUID = '669a9120-0008-968f-e311-6050405558b3';
export const MEDTRUM_WRITE_UUID = '669a9101-0008-968f-e311-6050405558b3';
/** "Need to skip to packet" — the pump is still busy, a further response follows. */
const RESPONSE_CODE_BUSY = 16384;
export const describeWriteError = (e) => {
    switch (e.kind) {
        case 'notSent':
            return `not sent: ${e.message}`;
        case 'timeout':
            return 'pump did not answer in time';
        case 'disconnected':
            return 'connection lost';
        case 'writeFailed':
            return `write failed: ${e.message}`;
        case 'invalidResponse':
            return `pump rejected the command (code ${e.code}${e.code === 7 ? ': invalid authorization' : e.code === 8 ? ': patch not in the required state' : ''})`;
        case 'invalidData':
            return `invalid response: ${e.message}`;
    }
};
/**
 * True when the command may or may not have been executed by the pump. Only an intact answer
 * with a non-zero response code is a definite rejection.
 */
export const isUncertain = (e) => e.kind !== 'invalidResponse' && e.kind !== 'notSent';
export class MedtrumLink {
    conn;
    o;
    writeSequence = 0;
    pending = null;
    queue = Promise.resolve();
    unsubscribers = [];
    invalidated = false;
    constructor(conn, o) {
        this.conn = conn;
        this.o = o;
    }
    get isOpen() {
        return !this.invalidated;
    }
    /** Enables notifications on both characteristics and starts listening for disconnects. */
    async start() {
        this.unsubscribers.push(this.conn.onDisconnect((e) => {
            this.invalidate();
            this.o.onDisconnect(e);
        }));
        this.unsubscribers.push(await this.conn.subscribe(MEDTRUM_SERVICE_UUID, MEDTRUM_READ_UUID, (d) => this.handleStatus(d)));
        this.unsubscribers.push(await this.conn.subscribe(MEDTRUM_SERVICE_UUID, MEDTRUM_WRITE_UUID, (d) => this.handleResponse(d)));
    }
    /** Stops using this link (the caller disconnects the BLE connection). Fails a command in flight. */
    invalidate() {
        if (this.invalidated)
            return;
        this.invalidated = true;
        this.unsubscribers.forEach((u) => u());
        this.unsubscribers = [];
        const p = this.pending;
        this.pending = null;
        p?.finish({ ok: false, error: { kind: 'disconnected' } });
    }
    /** Serialized: a second call waits until the first has its answer (or timed out). */
    writePacket(packet) {
        const run = this.queue.then(() => this.writeNow(packet));
        this.queue = run.catch(() => undefined);
        return run;
    }
    async writeNow(packet) {
        if (this.invalidated)
            return { ok: false, error: { kind: 'notSent', message: 'not connected' } };
        const sequence = this.writeSequence;
        let packages;
        try {
            packages = packet.encode(sequence);
        }
        catch (e) {
            return { ok: false, error: { kind: 'notSent', message: e instanceof Error ? e.message : String(e) } };
        }
        this.writeSequence = this.writeSequence + 1 >= 254 ? 0 : this.writeSequence + 1;
        let timer;
        const result = new Promise((resolve) => {
            const finish = (r) => {
                if (timer)
                    clearTimeout(timer);
                if (this.pending?.finish === finish)
                    this.pending = null;
                resolve(r);
            };
            this.pending = { packet: packet, sequence, finish };
            timer = setTimeout(() => {
                this.o.log.warn('Medtrum: Timeout has been reached...');
                finish({ ok: false, error: { kind: 'timeout' } });
            }, this.o.writeTimeoutMs);
        });
        try {
            for (const pkg of packages) {
                await this.conn.write(MEDTRUM_SERVICE_UUID, MEDTRUM_WRITE_UUID, pkg, true);
            }
        }
        catch (e) {
            // The first fragment may have reached the pump; the caller treats this as uncertain.
            this.pending?.finish({ ok: false, error: { kind: 'writeFailed', message: e instanceof Error ? e.message : String(e) } });
        }
        return (await result);
    }
    handleResponse(data) {
        if (data.length === 0)
            return;
        const pending = this.pending;
        if (!pending) {
            this.o.log.warn('Medtrum: No packet available...');
            return;
        }
        // Byte 2 echoes the sequence number of the command this is a response to, on every
        // fragment. It has to be checked on all of them, not just the first: decode() validates
        // a continuation fragment for ordering and CRC only, so a late fragment of an abandoned
        // command would otherwise be appended to whatever packet is now in flight.
        if (data.length > 2 && data[2] !== pending.sequence) {
            this.o.log.warn(`Medtrum: Ignoring response for sequence ${data[2]}, waiting on ${pending.sequence}`);
            return;
        }
        const packet = pending.packet;
        packet.decode(data);
        if (!packet.isComplete) {
            // Waiting for more data... (a failed fragment still ends in a timeout or a mismatching size)
            if (!packet.failed)
                return;
        }
        if (packet.responseCode === RESPONSE_CODE_BUSY && !packet.failed) {
            // DEVIATION: MedtrumKit keeps the decoded bytes here, so a following response would be
            // decoded as a continuation fragment. We start over and wait for the real answer.
            this.o.log.info(`Medtrum: pump busy, skipping message ${hex(packet.totalData)}`);
            packet.resetDecoder();
            return;
        }
        let response;
        // DEVIATION (order): Swift checks the response code first. A failed CRC makes the code itself
        // untrustworthy, so a corrupted answer is reported as invalid data (= outcome uncertain).
        if (packet.failed) {
            response = { ok: false, error: { kind: 'invalidData', message: 'wrong command type, sequence or CRC' } };
        }
        else if (packet.responseCode !== 0) {
            this.o.log.error(`Medtrum: Invalid responseCode: ${packet.responseCode}`);
            response = { ok: false, error: { kind: 'invalidResponse', code: packet.responseCode } };
        }
        else if (!packet.hasEnoughData) {
            response = {
                ok: false,
                error: { kind: 'invalidData', message: `expected ${packet.minimumDataSize} bytes, got ${hex(packet.totalData)}` },
            };
        }
        else {
            try {
                response = { ok: true, data: packet.parseResponse() };
            }
            catch (e) {
                response = { ok: false, error: { kind: 'invalidData', message: e instanceof Error ? e.message : String(e) } };
            }
        }
        pending.finish(response);
    }
    handleStatus(data) {
        if (data.length === 0)
            return;
        const packet = new NotificationPacket();
        // not a command response: no header, no CRC
        packet.totalData = data;
        if (!packet.hasEnoughData) {
            this.o.log.error(`Medtrum: Heartbeat notification too short to parse: ${hex(data)}`);
            return;
        }
        this.o.onStatus(packet.parseResponse());
    }
}
