import { hex } from '@buddy/core';
import { ADVERTISEMENT_SERVICE, CGM_CHARACTERISTIC, CGM_SERVICE, errorOf, NotifyChannel, SerialQueue, Sleeper, withTimeout } from '../dexcom-g6/ble-common';
import { G7Opcode, parseAuthChallengeRx, parseExtendedVersionMessage, parseG7BackfillMessage, parseG7GlucoseMessage, } from './messages';
export const G7_DEFAULT_LIFETIME_MS = 10 * 24 * 3600 * 1000;
export const G7_DEFAULT_WARMUP_MS = 27 * 60 * 1000;
export const G7_GRACE_PERIOD_MS = 12 * 3600 * 1000;
export const DEFAULT_G7_TIMING = {
    scanWindowMs: 60_000,
    reconnectDelayMs: 30_000,
    rescanDelayMs: 2_000,
    responseTimeoutMs: 2_000,
    adapterRetryMs: 5_000,
};
export class G7Sensor {
    o;
    /** The activation date of the sensor (epoch ms), derived from the latest glucose message. */
    activationDate = null;
    needsVersionInfo = false;
    sensorID;
    /** Used to detect connections that do not authenticate, signalling possible sensor switchover. */
    pendingAuth = false;
    /** The backfill data buffer. */
    backfillBuffer = [];
    timing;
    sleeper = new Sleeper();
    running = false;
    loop = null;
    conn = null;
    localDisconnect = false;
    constructor(o) {
        this.o = o;
        this.sensorID = o.sensorID;
        this.timing = { ...DEFAULT_G7_TIMING, ...o.timing };
    }
    get followedSensorID() {
        return this.sensorID;
    }
    get isRunning() {
        return this.running;
    }
    get isConnected() {
        return this.conn !== null;
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
        await this.disconnectCurrent();
        await this.loop;
        this.loop = null;
    }
    /** Forgets the followed sensor and looks for any new one. */
    scanForNewSensor() {
        this.sensorID = null;
        void this.disconnectCurrent();
        this.sleeper.cancelAll();
    }
    /**
     * The Dexcom G7 advertises a peripheral name of "DXCMxx", and later reports a full name of "Dexcomxx".
     * Dexcom One+ peripheral names start with "DX02".
     */
    shouldConnect(name) {
        if (!name)
            return 'ignore';
        if (name.startsWith('DXCM') || name.startsWith('DX02')) {
            // If we're following this name or if we're scanning, connect
            if (this.sensorID !== null && name.slice(-2) === this.sensorID.slice(-2))
                return 'makeActive';
            if (this.sensorID === null)
                return 'connect';
        }
        this.o.log.info(`Dexcom G7: not connecting to peripheral ${name}`);
        return 'ignore';
    }
    async disconnectCurrent() {
        if (!this.conn)
            return;
        this.localDisconnect = true;
        await this.conn.disconnect().catch(() => undefined);
    }
    // ── connection loop (G7BluetoothManager) ────────────────────────────────────
    async runLoop() {
        while (this.running) {
            let delay = this.timing.rescanDelayMs;
            try {
                if ((await this.o.ble.state()) !== 'poweredOn') {
                    await this.sleeper.sleep(this.timing.adapterRetryMs);
                    continue;
                }
                const ad = await this.scanForPeripheral();
                if (!ad || !this.running)
                    continue;
                const wasActive = await this.runConnection(ad);
                if (wasActive && !this.localDisconnect)
                    delay = this.timing.reconnectDelayMs;
            }
            catch (e) {
                this.o.delegate.didError(errorOf(e));
            }
            if (this.running)
                await this.sleeper.sleep(delay);
        }
    }
    async scanForPeripheral() {
        let found = null;
        await this.o.ble.scan({ services: [ADVERTISEMENT_SERVICE], timeoutMs: this.timing.scanWindowMs }, (ad) => {
            if (found || this.shouldConnect(ad.name) === 'ignore')
                return;
            found = ad;
            this.o.ble.stopScan();
        });
        return found;
    }
    /** Returns whether the link was to the followed ("active") sensor. */
    async runConnection(ad) {
        const name = ad.name ?? '';
        const conn = await this.o.ble.connect(ad.id);
        this.conn = conn;
        this.localDisconnect = false;
        const disconnected = new Promise((resolve) => conn.onDisconnect(resolve));
        const queue = new SerialQueue((e) => this.o.delegate.didError(e));
        const control = new NotifyChannel(conn, CGM_CHARACTERISTIC.control, (d) => this.didReceiveControlResponse(d, name, conn, backfill, queue));
        const backfill = new NotifyChannel(conn, CGM_CHARACTERISTIC.backfill, (d) => this.didReceiveBackfillResponse(d));
        const authentication = new NotifyChannel(conn, CGM_CHARACTERISTIC.authentication, (d) => {
            const message = parseAuthChallengeRx(d);
            if (message?.isBonded && message.isAuthenticated) {
                this.o.log.info('Dexcom G7: observed authenticated session, enabling notifications for control characteristic');
                this.pendingAuth = false;
                queue.perform(() => control.listen(this.timing.responseTimeoutMs));
            }
            else {
                this.o.log.info(`Dexcom G7: ignoring authentication response ${hex(d)}`);
            }
        });
        try {
            // readied
            if (this.sensorID !== null && this.sensorID === name)
                this.o.delegate.sensorDidConnect(name);
            this.o.log.info(`Dexcom G7: listening for authentication responses for ${name}`);
            queue.perform(async () => {
                await authentication.listen(this.timing.responseTimeoutMs);
                this.pendingAuth = true;
            });
            const error = await disconnected;
            if (error)
                this.o.log.info(`Dexcom G7: disconnected: ${error.message}`);
            const wasRemoteDisconnect = !this.localDisconnect;
            return this.peripheralDidDisconnect(name, wasRemoteDisconnect);
        }
        finally {
            for (const ch of [authentication, control, backfill]) {
                ch.failAll(new Error('Disconnected'));
                ch.stopListening();
            }
            await queue.drain();
            this.conn = null;
        }
    }
    peripheralDidDisconnect(name, wasRemoteDisconnect) {
        if (this.sensorID === null || this.sensorID !== name) {
            this.pendingAuth = false;
            return false;
        }
        // Sometimes we do not receive the backfillFinished message before disconnect
        this.flushBackfillBuffer();
        // Normal disconnect without auth is likely that the G7 app stopped this session
        const suspectedEndOfSession = this.pendingAuth && wasRemoteDisconnect;
        this.o.log.info(`Dexcom G7: sensor disconnected, wasRemoteDisconnect=${wasRemoteDisconnect}`);
        this.pendingAuth = false;
        this.o.delegate.sensorDisconnected(suspectedEndOfSession);
        return true;
    }
    // ── notifications ───────────────────────────────────────────────────────────
    didReceiveControlResponse(response, name, conn, backfill, queue) {
        if (response.length === 0)
            return;
        this.o.log.info(`Dexcom G7: received control response ${hex(response)}`);
        switch (response[0]) {
            case G7Opcode.glucoseTx: {
                const message = parseG7GlucoseMessage(response);
                if (message)
                    this.handleGlucoseMessage(message, name, conn, backfill, queue);
                else
                    this.o.delegate.didError(new Error('Unable to handle glucose control response'));
                return;
            }
            case G7Opcode.extendedVersionTx: {
                const version = parseExtendedVersionMessage(response);
                if (version) {
                    this.o.delegate.didReceiveExtendedVersion(version);
                    this.needsVersionInfo = false;
                }
                return;
            }
            case G7Opcode.backfillFinished:
                this.flushBackfillBuffer();
                return;
            default:
                return;
        }
    }
    handleGlucoseMessage(message, name, conn, backfill, queue) {
        this.activationDate = this.o.clock.now() - message.messageTimestamp * 1000;
        queue.perform(async () => {
            // Subscribe to backfill updates
            try {
                await backfill.listen(this.timing.responseTimeoutMs);
            }
            catch (e) {
                this.o.log.error(`Dexcom G7: error enabling notifications on backfill characteristic: ${errorOf(e).message}`);
                this.o.delegate.didError(errorOf(e));
            }
        });
        const requestVersion = () => queue.perform(async () => {
            try {
                await this.requestExtendedVersion(conn);
            }
            catch (e) {
                this.o.log.error(`Dexcom G7: error requesting extended version: ${errorOf(e).message}`);
            }
        });
        if (this.needsVersionInfo && name && name === this.sensorID)
            requestVersion();
        if (this.sensorID === null && name && this.activationDate !== null) {
            if (this.o.delegate.didDiscoverNewSensor(name, this.activationDate)) {
                this.sensorID = name;
                this.needsVersionInfo = true;
                this.o.delegate.didRead(message);
                requestVersion();
            }
        }
        else if (this.sensorID !== null) {
            this.o.delegate.didRead(message);
        }
        else {
            this.o.log.error(`Dexcom G7: dropping unhandled glucose message ${hex(message.data)}`);
        }
    }
    requestExtendedVersion(conn) {
        this.o.log.info('Dexcom G7: requesting sensor extended version');
        return withTimeout(conn.write(CGM_SERVICE, CGM_CHARACTERISTIC.control, new Uint8Array([G7Opcode.extendedVersionTx]), true), 1_000, 'Timed out requesting extended version');
    }
    didReceiveBackfillResponse(response) {
        if (response.length !== 9)
            return;
        const message = parseG7BackfillMessage(response);
        if (message)
            this.backfillBuffer = [...this.backfillBuffer, message];
    }
    flushBackfillBuffer() {
        if (this.backfillBuffer.length === 0)
            return;
        const backfill = this.backfillBuffer;
        this.backfillBuffer = [];
        this.o.delegate.didReadBackfill(backfill);
    }
}
