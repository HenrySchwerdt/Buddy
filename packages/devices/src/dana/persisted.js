/**
 * Persistence of the DanaKit pump-manager state that must survive app restarts (pairing keys,
 * BLE identifier, history cursor). Replaces the `rawState` dictionary of
 * DanaKit/PumpManager/DanaKitPumpManagerState.swift from loopandlearn/DanaKit
 * (MIT, © 2021 Randall Knutson and the DanaKit authors) with a keychain-backed `SecretStore`.
 */
import { fromHex, hex } from '@buddy/core';
export const secretKey = (deviceName) => `dana-i:${deviceName.toUpperCase()}`;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
function parseFingerprints(v) {
    if (!Array.isArray(v))
        return [];
    return v.flatMap((x) => {
        if (typeof x !== 'object' || x === null)
            return [];
        const f = x;
        if (typeof f.id !== 'string' || !num(f.start) || !num(f.end) || !num(f.requested))
            return [];
        return [{ id: f.id, start: f.start, end: f.end, requested: f.requested, ...(typeof f.recordId === 'string' ? { recordId: f.recordId } : {}) }];
    });
}
const isHex = (v, bytes) => typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/i.test(v);
/** Validates everything read back from storage (never trust stored data blindly). */
export function parsePersisted(raw) {
    if (!raw)
        return {};
    let v;
    try {
        v = JSON.parse(raw);
    }
    catch {
        return {};
    }
    if (typeof v !== 'object' || v === null)
        return {};
    const o = v;
    return {
        ...(typeof o.bleId === 'string' && o.bleId.length > 0 ? { bleId: o.bleId } : {}),
        ...(isHex(o.pairingKey, 6) && isHex(o.randomPairingKey, 3) ? { pairingKey: o.pairingKey, randomPairingKey: o.randomPairingKey } : {}),
        ...(isHex(o.ble5Keys, 6) ? { ble5Keys: o.ble5Keys } : {}),
        ...(num(o.historyFrom) ? { historyFrom: o.historyFrom } : {}),
        ...(Array.isArray(o.fingerprints) ? { fingerprints: parseFingerprints(o.fingerprints) } : {}),
    };
}
export const bytesOrEmpty = (h) => (h ? fromHex(h) : new Uint8Array(0));
export const hexOrUndefined = (b) => (b.length > 0 ? hex(b) : undefined);
export class DanaStore {
    secrets;
    key;
    log;
    cache = null;
    constructor(secrets, key, log) {
        this.secrets = secrets;
        this.key = key;
        this.log = log;
    }
    async load() {
        if (!this.cache)
            this.cache = parsePersisted(await this.secrets.get(this.key));
        return this.cache;
    }
    async update(patch) {
        await this.load();
        // Read the cache after the await so concurrent updates never overwrite each other
        const next = { ...this.cache, ...patch };
        this.cache = next;
        try {
            await this.secrets.set(this.key, JSON.stringify(next));
        }
        catch (e) {
            this.log.error(`Dana: could not persist pump state: ${String(e)}`);
        }
    }
    /** Read-modify-write against the current state (no lost updates between concurrent writers). */
    async modify(fn) {
        await this.load();
        await this.update(fn(this.cache ?? {}));
    }
    async clear() {
        this.cache = {};
        await this.secrets.set(this.key, null);
    }
}
