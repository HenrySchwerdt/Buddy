const QUIET_RESET_MS = 6_000;
const DEFAULT_SCAN_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;
export class LibreBleSession {
    o;
    conn = null;
    cleanups = [];
    stopped = true;
    timer = null;
    lastNotify = null;
    queue = Promise.resolve();
    constructor(o) {
        this.o = o;
    }
    get connected() {
        return this.conn !== null;
    }
    /** Finds (or reuses) the peripheral and connects. Rejects if the first connection fails. */
    async start() {
        if (!this.stopped)
            return;
        const state = await this.o.ble.state();
        if (state !== 'poweredOn')
            throw new Error(`Bluetooth is not available (${state})`);
        this.stopped = false;
        try {
            await this.connectOnce();
        }
        catch (e) {
            this.stopped = true;
            throw e;
        }
    }
    async stop() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
        this.o.ble.stopScan();
        const conn = this.conn;
        this.teardown();
        if (conn)
            await conn.disconnect().catch(() => { });
    }
    teardown() {
        for (const c of this.cleanups)
            c();
        this.cleanups = [];
        this.conn = null;
        this.o.protocol.reset();
    }
    async findDevice() {
        const known = await this.o.loadDeviceId();
        if (known)
            return known;
        let found = null;
        await this.o.ble.scan({ services: [this.o.protocol.service], timeoutMs: this.o.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS }, (ad) => {
            if (found || !this.o.protocol.matches(ad))
                return;
            found = ad;
            this.o.ble.stopScan();
        });
        const ad = found;
        if (!ad)
            throw new Error('No matching Libre sensor or transmitter found nearby');
        await this.o.protocol.onSelected?.(ad);
        await this.o.saveDeviceId(ad.id);
        return ad.id;
    }
    async connectOnce() {
        const id = await this.findDevice();
        if (this.stopped)
            return;
        const conn = await this.o.ble.connect(id, { timeoutMs: 30_000 });
        if (this.stopped) {
            await conn.disconnect().catch(() => { });
            return;
        }
        this.conn = conn;
        this.o.protocol.reset();
        this.cleanups.push(conn.onDisconnect((err) => this.onDisconnect(err)));
        const p = this.o.protocol;
        try {
            this.cleanups.push(await conn.subscribe(p.service, p.notifyCharacteristic, (data) => this.enqueue(() => this.handleNotify(data))));
            await this.write(await p.afterSubscribe());
        }
        catch (e) {
            this.teardown();
            await conn.disconnect().catch(() => { });
            throw e;
        }
        this.o.log.info(`Libre: connected to ${id}`);
    }
    enqueue(task) {
        this.queue = this.queue.then(task).catch((e) => this.o.log.error(`Libre: ${e.message}`));
    }
    /** Resolves once every notification received so far has been processed (for tests). */
    idle() {
        return this.queue;
    }
    async handleNotify(data) {
        const now = this.o.clock.now();
        if (this.lastNotify !== null && now > this.lastNotify + QUIET_RESET_MS)
            this.o.protocol.reset();
        this.lastNotify = now;
        await this.write(await this.o.protocol.onNotify(data));
    }
    async write(commands) {
        const conn = this.conn;
        if (!conn)
            return;
        const p = this.o.protocol;
        for (const c of commands)
            await conn.write(p.service, p.writeCharacteristic, c, true);
    }
    onDisconnect(error) {
        this.o.log.warn(`Libre: disconnected${error ? ` (${error.message})` : ''}`);
        this.teardown();
        if (!this.stopped)
            this.scheduleReconnect(this.o.protocol.reconnectDelayMs());
    }
    scheduleReconnect(delayMs) {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.stopped)
                return;
            this.connectOnce().catch((e) => {
                this.o.log.warn(`Libre: reconnect failed (${e.message})`);
                if (!this.stopped && !this.conn)
                    this.scheduleReconnect(this.o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
            });
        }, delayMs);
    }
}
