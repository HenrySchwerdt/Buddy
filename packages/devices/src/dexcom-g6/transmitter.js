import { hex } from '@buddy/core';
import { computeHash } from './auth';
import { appendBackfillFrame, backfillByteCount, backfillCrc16, backfillGlucose, createBackfillFrameBuffer, } from './backfill';
import { ADVERTISEMENT_SERVICE, CGM_CHARACTERISTIC, CGM_SERVICE, errorOf, NotifyChannel, SerialQueue, Sleeper, withTimeout } from './ble-common';
import { makeGlucose } from './glucose';
import { authChallengeTx, authRequestTx, bondRequestTx, calibrationDataTx, disconnectTx, glucoseTx, isKnownOpcode, keepAliveTx, Opcode, parseAuthChallengeRx, parseAuthRequestRx, parseCalibrationDataRx, parseGlucoseBackfillRx, parseGlucoseRx, parseTransmitterTimeRx, parseTransmitterVersionRx, transmitterTimeTx, transmitterVersionTx, } from './messages';
export const DEFAULT_G6_TIMING = {
    scanWindowMs: 60_000,
    rescanDelayMs: 2_000,
    responseTimeoutMs: 2_000,
    bondTimeoutMs: 15_000,
    adapterRetryMs: 5_000,
};
const defaultToken = () => {
    const b = new Uint8Array(8);
    globalThis.crypto.getRandomValues(b);
    return b;
};
export class Transmitter {
    o;
    needsExpiryRead;
    timing;
    running = false;
    loop = null;
    conn = null;
    sleeper = new Sleeper();
    // Passive observation state
    /** The initial activation date of the transmitter (epoch ms). */
    activationDate;
    /** The last-observed time message. */
    lastTimeMessage = null;
    /** The last-observed calibration message. */
    lastCalibrationMessage = null;
    /** The backfill data buffer. */
    backfillBuffer = null;
    constructor(o) {
        this.o = o;
        this.timing = { ...DEFAULT_G6_TIMING, ...o.timing };
        this.activationDate = o.activationDate;
        this.needsExpiryRead = o.needsExpiryRead;
    }
    get id() {
        return this.o.id;
    }
    get isRunning() {
        return this.running;
    }
    resumeScanning() {
        if (this.running)
            return;
        this.running = true;
        this.loop = this.runLoop();
    }
    async stopScanning() {
        this.running = false;
        this.o.ble.stopScan();
        this.sleeper.cancelAll();
        await this.conn?.disconnect().catch(() => undefined);
        await this.loop;
        this.loop = null;
    }
    /** The Dexcom G5/G6 advertises a peripheral name of "DexcomXX" where "XX" is the last two characters of the transmitter ID. */
    shouldConnect(ad) {
        if (ad.name && ad.name.slice(-2) === this.o.id.slice(-2))
            return true;
        this.o.log.info(`Dexcom G6: not connecting to peripheral ${ad.name ?? ad.id}`);
        return false;
    }
    // ── connection loop (BluetoothManager) ──────────────────────────────────────
    async runLoop() {
        while (this.running) {
            try {
                if ((await this.o.ble.state()) !== 'poweredOn') {
                    await this.sleeper.sleep(this.timing.adapterRetryMs);
                    continue;
                }
                const deviceId = await this.scanForPeripheral();
                if (!deviceId || !this.running)
                    continue;
                await this.runConnection(deviceId);
            }
            catch (e) {
                this.o.delegate.didError(errorOf(e));
            }
            if (this.running)
                await this.sleeper.sleep(this.timing.rescanDelayMs);
        }
    }
    async scanForPeripheral() {
        let found = null;
        await this.o.ble.scan({ services: [ADVERTISEMENT_SERVICE], timeoutMs: this.timing.scanWindowMs }, (ad) => {
            if (found || !this.shouldConnect(ad))
                return;
            found = ad.id;
            this.o.ble.stopScan();
        });
        return found;
    }
    async runConnection(deviceId) {
        const conn = await this.o.ble.connect(deviceId);
        this.conn = conn;
        const disconnected = new Promise((resolve) => conn.onDisconnect(resolve));
        try {
            this.o.delegate.transmitterDidConnect();
            if (this.o.passiveModeEnabled) {
                await this.listenPassively(conn, disconnected);
            }
            else {
                await this.readActively(conn);
                // The transmitter drops the link after DisconnectTx; make sure we do too.
                await conn.disconnect().catch(() => undefined);
            }
            const error = await disconnected;
            // Ignore errors indicating the peripheral disconnected remotely, as that's expected behavior.
            if (error)
                this.o.log.info(`Dexcom G6 disconnected: ${error.message}`);
        }
        catch (e) {
            await conn.disconnect().catch(() => undefined);
            throw e;
        }
        finally {
            this.conn = null;
        }
    }
    // ── active mode ─────────────────────────────────────────────────────────────
    async readActively(conn) {
        const t = this.timing;
        const control = new NotifyChannel(conn, CGM_CHARACTERISTIC.control, () => undefined);
        try {
            this.o.log.info('Dexcom G6: authenticating with transmitter');
            const status = await this.authenticate(conn);
            if (!status.isBonded) {
                this.o.log.info('Dexcom G6: requesting bond');
                await this.requestBond(conn);
                this.o.log.info('Dexcom G6: bonding request sent, waiting for user to respond');
            }
            try {
                await control.listen(status.isBonded ? t.responseTimeoutMs : t.bondTimeoutMs);
            }
            catch (e) {
                throw new Error(`Error enabling notification: ${errorOf(e).message}`);
            }
            try {
                const timeMessage = await control
                    .request(transmitterTimeTx(), parseTransmitterTimeRx, t.responseTimeoutMs)
                    .catch((e) => Promise.reject(new Error(`Error getting time: ${errorOf(e).message}`)));
                const activationDate = this.o.clock.now() - timeMessage.currentTime * 1000;
                const glucoseMessage = await control
                    .request(glucoseTx(), parseGlucoseRx, t.responseTimeoutMs)
                    .catch((e) => Promise.reject(new Error(`Error getting glucose: ${errorOf(e).message}`)));
                const calibrationMessage = await control.request(calibrationDataTx(), parseCalibrationDataRx, t.responseTimeoutMs).catch(() => null);
                // Best-effort version read — surfaces transmitter-reported expiry (Anubis detection).
                // Optional: don't fail the connect cycle if the transmitter doesn't answer.
                const version = await control.request(transmitterVersionTx(), parseTransmitterVersionRx, t.responseTimeoutMs).catch(() => null);
                if (version)
                    this.o.delegate.didReadTransmitterVersion(version);
                this.o.delegate.didRead(makeGlucose({
                    transmitterId: this.o.id,
                    status: glucoseMessage.status,
                    glucoseMessage: glucoseMessage.glucose,
                    timeMessage,
                    calibrationMessage,
                    activationDate,
                    sensorLifeDays: this.o.sensorLifeDays?.(),
                }));
            }
            finally {
                this.o.log.info('Dexcom G6: initiating a disconnect');
                control.stopListening();
                await conn.write(CGM_SERVICE, CGM_CHARACTERISTIC.control, disconnectTx(), true).catch(() => undefined);
            }
        }
        finally {
            control.failAll(new Error('Session ended'));
        }
    }
    async authenticate(conn) {
        const token = (this.o.randomToken ?? defaultToken)();
        const auth = CGM_CHARACTERISTIC.authentication;
        await conn.write(CGM_SERVICE, auth, authRequestTx(token), true).catch((e) => {
            throw new Error(`Error writing transmitter challenge: ${errorOf(e).message}`);
        });
        const authResponse = parseAuthRequestRx(await this.readAuth(conn));
        if (!authResponse)
            throw new Error('Unable to parse auth challenge');
        const expected = computeHash(this.o.id, token);
        if (!expected || hex(expected) !== hex(authResponse.tokenHash))
            throw new Error('Transmitter failed auth challenge');
        const challengeHash = computeHash(this.o.id, authResponse.challenge);
        if (!challengeHash)
            throw new Error('Failed to compute challenge hash for transmitter ID');
        await conn.write(CGM_SERVICE, auth, authChallengeTx(challengeHash), true).catch((e) => {
            throw new Error(`Error writing challenge response: ${errorOf(e).message}`);
        });
        const challengeResponse = parseAuthChallengeRx(await this.readAuth(conn));
        if (!challengeResponse)
            throw new Error('Unable to parse auth status');
        if (!challengeResponse.isAuthenticated)
            throw new Error('Transmitter rejected auth challenge');
        return challengeResponse;
    }
    readAuth(conn) {
        return withTimeout(conn.read(CGM_SERVICE, CGM_CHARACTERISTIC.authentication), this.timing.responseTimeoutMs, 'Timed out reading authentication');
    }
    async requestBond(conn) {
        const auth = CGM_CHARACTERISTIC.authentication;
        await conn.write(CGM_SERVICE, auth, keepAliveTx(25), true).catch((e) => {
            throw new Error(`Error writing keep-alive for bond: ${errorOf(e).message}`);
        });
        await conn.write(CGM_SERVICE, auth, bondRequestTx(), true).catch((e) => {
            throw new Error(`Error writing bond request: ${errorOf(e).message}`);
        });
    }
    // ── passive mode ────────────────────────────────────────────────────────────
    async listenPassively(conn, disconnected) {
        const queue = new SerialQueue((e) => this.o.delegate.didError(e));
        const control = new NotifyChannel(conn, CGM_CHARACTERISTIC.control, (d) => this.didReceiveControlResponse(d, control, backfill, queue));
        const backfill = new NotifyChannel(conn, CGM_CHARACTERISTIC.backfill, (d) => this.didReceiveBackfillResponse(d));
        const authentication = new NotifyChannel(conn, CGM_CHARACTERISTIC.authentication, (d) => {
            const message = parseAuthChallengeRx(d);
            if (message?.isBonded && message.isAuthenticated) {
                this.o.log.info('Dexcom G6: observed authenticated session, enabling notifications for control characteristic');
                // Stopping updates from authentication simultaneously with Dexcom's app causes CoreBluetooth to get into a weird state.
                queue.perform(() => control.listen(this.timing.responseTimeoutMs));
            }
            else {
                this.o.log.info(`Dexcom G6: ignoring authentication response ${hex(d)}`);
            }
        });
        this.o.log.info('Dexcom G6: listening for authentication responses in passive mode');
        try {
            await authentication.listen(this.timing.responseTimeoutMs);
            await disconnected;
        }
        finally {
            for (const ch of [authentication, control, backfill]) {
                ch.failAll(new Error('Disconnected'));
                ch.stopListening();
            }
            await queue.drain();
        }
    }
    didReceiveControlResponse(response, control, backfill, queue) {
        if (!this.o.passiveModeEnabled || response.length === 0)
            return;
        const opcode = response[0];
        switch (opcode) {
            case Opcode.glucoseRx:
            case Opcode.glucoseG6Rx: {
                const glucoseMessage = parseGlucoseRx(response);
                const timeMessage = this.lastTimeMessage;
                const activationDate = this.activationDate;
                if (glucoseMessage && timeMessage && activationDate !== null) {
                    this.o.delegate.didRead(makeGlucose({
                        transmitterId: this.o.id,
                        status: glucoseMessage.status,
                        glucoseMessage: glucoseMessage.glucose,
                        timeMessage,
                        calibrationMessage: this.lastCalibrationMessage,
                        activationDate,
                        sensorLifeDays: this.o.sensorLifeDays?.(),
                    }));
                }
                else {
                    this.o.delegate.didError(new Error('Unable to handle glucose control response'));
                }
                queue.perform(async () => {
                    // Subscribe to backfill updates
                    try {
                        await backfill.listen(this.timing.responseTimeoutMs);
                    }
                    catch (e) {
                        this.o.log.error(`Dexcom G6: error enabling notifications on backfill characteristic: ${errorOf(e).message}`);
                        this.o.delegate.didError(errorOf(e));
                    }
                    if (this.needsExpiryRead) {
                        const version = await control.request(transmitterVersionTx(), parseTransmitterVersionRx, this.timing.responseTimeoutMs).catch(() => null);
                        // The response is also delivered to this handler (transmitterVersionRx) which informs the delegate.
                        if (version)
                            this.needsExpiryRead = false;
                    }
                });
                return;
            }
            case Opcode.transmitterTimeRx: {
                const timeMessage = parseTransmitterTimeRx(response);
                if (timeMessage) {
                    this.lastTimeMessage = timeMessage;
                    this.activationDate = this.o.clock.now() - timeMessage.currentTime * 1000;
                }
                return;
            }
            case Opcode.glucoseBackfillRx:
                this.handleBackfillRx(response);
                return;
            case Opcode.calibrationDataRx: {
                const calibration = parseCalibrationDataRx(response);
                if (calibration)
                    this.lastCalibrationMessage = calibration;
                return;
            }
            case Opcode.transmitterVersionRx: {
                const version = parseTransmitterVersionRx(response);
                if (version)
                    this.o.delegate.didReadTransmitterVersion(version);
                return;
            }
            default:
                // We ignore all other known opcodes
                if (!isKnownOpcode(opcode))
                    this.o.delegate.didReadUnknownData(response);
        }
    }
    handleBackfillRx(response) {
        const backfillMessage = parseGlucoseBackfillRx(response);
        if (!backfillMessage)
            return;
        const fail = (msg) => {
            this.o.log.error(`Dexcom G6: ${msg}`);
            this.o.delegate.didError(new Error(msg));
        };
        const buffer = this.backfillBuffer;
        if (!buffer)
            return fail('Received GlucoseBackfillRxMessage but backfillBuffer is nil');
        const timeMessage = this.lastTimeMessage;
        const activationDate = this.activationDate;
        if (!timeMessage || activationDate === null)
            return fail('Received GlucoseBackfillRxMessage but activationDate is unknown');
        if (backfillMessage.bufferLength !== backfillByteCount(buffer)) {
            return fail(`GlucoseBackfillRxMessage expected buffer length ${backfillMessage.bufferLength}, but was ${backfillByteCount(buffer)}: ${hex(response)}`);
        }
        if (backfillMessage.bufferCrc !== backfillCrc16(buffer)) {
            return fail(`GlucoseBackfillRxMessage expected CRC ${backfillMessage.bufferCrc}, but was ${backfillCrc16(buffer)}`);
        }
        const glucose = backfillGlucose(buffer).map((m) => makeGlucose({ transmitterId: this.o.id, status: backfillMessage.status, glucoseMessage: m, timeMessage, activationDate, sensorLifeDays: this.o.sensorLifeDays?.() }));
        const first = glucose[0];
        const last = glucose[glucose.length - 1];
        if (!first || !last)
            return;
        if (first.glucoseMessage.timestamp !== backfillMessage.startTime ||
            last.glucoseMessage.timestamp !== backfillMessage.endTime ||
            first.glucoseMessage.timestamp > last.glucoseMessage.timestamp) {
            return fail(`GlucoseBackfillRxMessage time interval not reflected in glucose: ${backfillMessage.startTime} - ${backfillMessage.endTime}, buffer: ${first.glucoseMessage.timestamp} - ${last.glucoseMessage.timestamp}`);
        }
        this.o.delegate.didReadBackfill(glucose);
    }
    didReceiveBackfillResponse(response) {
        if (response.length <= 2)
            return;
        if (response[0] === 1) {
            this.o.log.info(`Dexcom G6: starting new backfill buffer with ID ${response[1]}`);
            this.backfillBuffer = createBackfillFrameBuffer(response[1]);
        }
        if (this.backfillBuffer)
            this.backfillBuffer = appendBackfillFrame(this.backfillBuffer, response);
    }
}
