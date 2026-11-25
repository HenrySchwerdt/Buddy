import { isPlausibleGlucose } from '../trend';
/*
 G5 BLE attributes, retrieved using LightBlue on 2015-10-01. G6 and G7 use the same layout.
 */
/** 16-bit 0xFEBC (Dexcom) expanded to the Bluetooth base UUID, as the transport expects 128-bit UUIDs. */
export const ADVERTISEMENT_SERVICE = '0000febc-0000-1000-8000-00805f9b34fb';
export const CGM_SERVICE = 'f8083532-849e-531c-c594-30f1f86a4ea5';
export const SERVICE_B = 'f8084532-849e-531c-c594-30f1f86a4ea5';
export const CGM_CHARACTERISTIC = {
    /** Read/Notify */
    communication: 'f8083533-849e-531c-c594-30f1f86a4ea5',
    /** Write/Indicate */
    control: 'f8083534-849e-531c-c594-30f1f86a4ea5',
    /** Write/Indicate */
    authentication: 'f8083535-849e-531c-c594-30f1f86a4ea5',
    /** Read/Write/Notify */
    backfill: 'f8083536-849e-531c-c594-30f1f86a4ea5',
};
/** Dexcom reports glucose clamped to this range ("LOW" / "HIGH" outside). */
export const GLUCOSE_LIMITS = { minimum: 40, maximum: 400 };
/**
 * Converts a raw sensor value to a Buddy mg/dL value or `null`.
 * Swift drops values below 39 and clamps the rest to 40…400; Buddy additionally drops
 * anything above 401 (never a valid Dexcom value).
 */
export function clampGlucose(raw) {
    if (!Number.isFinite(raw) || raw < 39 || raw > 401)
        return null;
    const v = Math.min(Math.max(raw, GLUCOSE_LIMITS.minimum), GLUCOSE_LIMITS.maximum);
    return isPlausibleGlucose(v) ? v : null;
}
/**
 * Rate of change (mg/dL/min) → trend arrow, using the LoopKit thresholds of both drivers
 * (G6 compares the raw ×10 value against ±10/20/30, which is the same thing).
 */
export function trendFromRate(rate) {
    if (rate === null || !Number.isFinite(rate))
        return 'unknown';
    if (rate <= -3)
        return 'doubleDown';
    if (rate <= -2)
        return 'singleDown';
    if (rate <= -1)
        return 'fortyFiveDown';
    if (rate < 1)
        return 'flat';
    if (rate < 2)
        return 'fortyFiveUp';
    if (rate < 3)
        return 'singleUp';
    return 'doubleUp';
}
/** In-memory reading buffer keyed by a sync identifier (consistent between live and backfill). */
export class ReadingBuffer {
    maxEntries;
    byId = new Map();
    constructor(maxEntries = 2016) {
        this.maxEntries = maxEntries;
    }
    add(syncId, reading) {
        if (this.byId.has(syncId))
            return false;
        this.byId.set(syncId, reading);
        if (this.byId.size > this.maxEntries) {
            const oldest = [...this.byId.entries()].sort((a, b) => a[1].date - b[1].date)[0];
            if (oldest)
                this.byId.delete(oldest[0]);
        }
        return true;
    }
    since(since) {
        return [...this.byId.values()].filter((r) => r.date > since).sort((a, b) => a.date - b.date);
    }
}
/** Cancellable sleeps so `stop()` never leaves timers behind. */
export class Sleeper {
    pending = new Set();
    sleep(ms) {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(t);
                this.pending.delete(done);
                resolve();
            };
            const t = setTimeout(done, ms);
            this.pending.add(done);
        });
    }
    cancelAll() {
        for (const done of [...this.pending])
            done();
    }
}
export function withTimeout(p, ms, message) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(message)), ms);
        p.then((v) => {
            clearTimeout(t);
            resolve(v);
        }, (e) => {
            clearTimeout(t);
            reject(e instanceof Error ? e : new Error(String(e)));
        });
    });
}
/**
 * A subscribed notify/indicate characteristic. Every value goes to `onData`; values that
 * parse as the response a pending `request` waits for also resolve that request
 * (mirrors PeripheralManager's `.valueUpdate` conditions: unrecognised values keep listening).
 */
export class NotifyChannel {
    conn;
    characteristic;
    onData;
    waiters = [];
    unsubscribe = null;
    constructor(conn, characteristic, onData) {
        this.conn = conn;
        this.characteristic = characteristic;
        this.onData = onData;
    }
    get isNotifying() {
        return this.unsubscribe !== null;
    }
    async listen(timeoutMs) {
        if (this.unsubscribe)
            return;
        this.unsubscribe = await withTimeout(this.conn.subscribe(CGM_SERVICE, this.characteristic, (d) => this.deliver(d)), timeoutMs, `Timed out enabling notifications on ${this.characteristic}`);
    }
    stopListening() {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
    /** Writes `payload` (with response) and resolves with the first indication `parse` accepts. */
    request(payload, parse, timeoutMs) {
        if (!this.unsubscribe)
            return Promise.reject(new Error(`Characteristic ${this.characteristic} is not notifying`));
        return new Promise((resolve, reject) => {
            const waiter = {
                parse,
                resolve: resolve,
                reject,
                timer: setTimeout(() => {
                    this.waiters = this.waiters.filter((w) => w !== waiter);
                    reject(new Error(`Timed out waiting for response to ${hexByte(payload[0])}`));
                }, timeoutMs),
            };
            this.waiters = [...this.waiters, waiter];
            this.conn.write(CGM_SERVICE, this.characteristic, payload, true).catch((e) => {
                clearTimeout(waiter.timer);
                this.waiters = this.waiters.filter((w) => w !== waiter);
                reject(e instanceof Error ? e : new Error(String(e)));
            });
        });
    }
    failAll(error) {
        const ws = this.waiters;
        this.waiters = [];
        for (const w of ws) {
            clearTimeout(w.timer);
            w.reject(error);
        }
    }
    deliver(data) {
        const matched = this.waiters.find((w) => w.parse(data) !== null);
        if (matched) {
            clearTimeout(matched.timer);
            this.waiters = this.waiters.filter((w) => w !== matched);
            matched.resolve(matched.parse(data));
        }
        this.onData(data);
    }
}
const hexByte = (b) => `0x${(b ?? 0).toString(16).padStart(2, '0')}`;
/** Serial async queue, the equivalent of `peripheralManager.perform { … }`. */
export class SerialQueue {
    onError;
    tail = Promise.resolve();
    constructor(onError) {
        this.onError = onError;
    }
    perform(fn) {
        this.tail = this.tail.then(fn).catch((e) => this.onError(e instanceof Error ? e : new Error(String(e))));
    }
    drain() {
        return this.tail;
    }
}
export const errorOf = (e) => (e instanceof Error ? e : new Error(String(e)));
