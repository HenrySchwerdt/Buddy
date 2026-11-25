import { decryptBle, parseBleData, streamingUnlockPayload } from './libre2-crypto';
export const LIBRE2_SERVICE = '0000fde3-0000-1000-8000-00805f9b34fb';
export const LIBRE2_WRITE = '0000f001-0000-1000-8000-00805f9b34fb';
export const LIBRE2_NOTIFY = '0000f002-0000-1000-8000-00805f9b34fb';
/** `enableTime` / unlock code used by both the NFC enable-streaming command and the BLE unlock. */
export const LIBRE2_UNLOCK_CODE = 42;
const EXPECTED_BUFFER_SIZE = 46;
const TREND_BUFFER_LIMIT = 30;
const TWENTY_MINUTES = 20 * 60_000;
/** `Libre2DirectTransmitter.canSupportPeripheral`: legacy `ABBOTT<serial>` names, or the MAC as name. */
export function canSupportLibre2Peripheral(name, macAddress) {
    if (!name)
        return false;
    if (name.toLowerCase().startsWith('abbott'))
        return true;
    return macAddress ? name.toLowerCase().includes(macAddress.toLowerCase()) : false;
}
/** `LibreTransmitterProxyManager.verifyLibre2ManufacturerData`: 8 bytes, bytes 2..7 + `07 e0` = UID. */
export function verifyLibre2ManufacturerData(manufacturerData, uid) {
    if (!manufacturerData || manufacturerData.length !== 8 || uid.length !== 8)
        return false;
    for (let i = 0; i < 6; i++)
        if (manufacturerData[i + 2] !== uid[i])
            return false;
    return uid[6] === 0x07 && uid[7] === 0xe0;
}
/** Discovery match from `centralManager(_:didDiscover:)` for a pre-selected Libre 2 sensor. */
export function matchesLibre2Advertisement(ad, sensor) {
    if (ad.name !== null && sensor.macAddress !== null && ad.name === sensor.macAddress)
        return true;
    return verifyLibre2ManufacturerData(ad.manufacturerData, sensor.uid) && canSupportLibre2Peripheral(ad.name, sensor.macAddress);
}
/** `Libre2DirectTransmitter.unlock()`: increments the unlock counter and builds the payload. */
export function nextUnlock(sensor) {
    const next = { ...sensor, unlockCount: sensor.unlockCount + 1 };
    return { sensor: next, payload: streamingUnlockPayload(next.uid, next.patchInfo, LIBRE2_UNLOCK_CODE, next.unlockCount & 0xffff) };
}
/** `LimitedQueue<T>`: drops the oldest element once `limit` is reached. */
export class LimitedQueue {
    limit;
    items = [];
    constructor(limit = 10) {
        this.limit = limit;
    }
    get array() {
        return this.items;
    }
    enqueue(element) {
        const kept = this.items.length >= this.limit ? this.items.slice(this.items.length - this.limit + 1) : this.items;
        this.items = [...kept, element];
    }
    removeAll() {
        this.items = [];
    }
}
const uniqueBy = (xs, key) => {
    const seen = new Set();
    return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};
/** Notification reassembly, decryption and trend buffering (`Libre2DirectTransmitter`). */
export class Libre2DirectTransmitter {
    shortTransmitterName = 'libre2';
    requiresDelayedReconnect = false;
    rxBuffer = [];
    bufferedTrends = new LimitedQueue(TREND_BUFFER_LIMIT);
    lastSensorUid = null;
    reset() {
        this.rxBuffer = [];
    }
    /** `updateValueForNotifyCharacteristics`; a packet is handled when exactly 46 bytes are buffered. */
    onNotify(value, sensor, now) {
        this.rxBuffer.push(...value);
        if (this.rxBuffer.length !== EXPECTED_BUFFER_SIZE)
            return { kind: 'incomplete' };
        return this.handleCompleteMessage(sensor, now);
    }
    handleCompleteMessage(sensor, now) {
        if (!sensor) {
            this.reset();
            return { kind: 'error', error: 'noSensor' };
        }
        let decrypted;
        try {
            decrypted = decryptBle(sensor.uid, this.rxBuffer);
        }
        catch {
            this.reset();
            return { kind: 'error', error: 'decryptionFailed' };
        }
        const update = parseBleData(decrypted, now);
        // Swift returns here without resetting the buffer (unreachable in practice: decryptBle checks the CRC).
        if (!update.crcVerified)
            return { kind: 'error', error: 'checksumValidationError' };
        const uidKey = Array.from(sensor.uid).join(',');
        if (this.lastSensorUid !== null && this.lastSensorUid !== uidKey)
            this.bufferedTrends.removeAll();
        this.lastSensorUid = uidKey;
        let trend = update.trend;
        const latest = update.trend[update.trend.length - 1];
        const oldest = update.trend[0];
        if (latest && oldest) {
            // previously captured trends that are recent enough but older than this packet's trends
            const latestDate = latest.date - TWENTY_MINUTES;
            const filtered = uniqueBy(this.bufferedTrends.array.filter((m) => m.date > latestDate && m.date < oldest.date), (m) => m.idValue);
            for (const t of update.trend) {
                if (!this.bufferedTrends.array.some((m) => m.date > t.date))
                    this.bufferedTrends.enqueue(t);
            }
            if (filtered.length > 0)
                trend = [...trend, ...filtered];
        }
        this.reset();
        return { kind: 'update', response: { ...update, trend } };
    }
}
