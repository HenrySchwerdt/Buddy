/**
 * TypeScript port of `Bluetooth/Transmitter/MiaomiaoTransmitter.swift`,
 * `Bluetooth/Transmitter/BubbleTransmitter.swift` and `Bluetooth/LibreTransmitterMetadata.swift`
 * (struct `LibreTransmitterMetadata`) from loopandlearn/LibreTransmitter (MIT, (c) the
 * LibreTransmitter / LoopKit authors).
 *
 * Third-party NFC-to-BLE bridges clipped onto a Libre 1 / Libre 2 sensor. Both share the Nordic
 * UART service and deliver the full 344-byte FRAM every few minutes. These classes are pure
 * framing state machines: they consume notifications and return the writes the Swift code would
 * issue plus any complete FRAM packet. No BLE I/O happens here.
 */
import { hex } from '@buddy/core';
import { SensorData } from './sensor-data';
export const NORDIC_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_UART_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_UART_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const appendBytes = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
};
const MIAOMIAO_PACKET_LENGTH = 363;
const MIAOMIAO_WITH_PATCHINFO_LENGTH = 369;
/** MiaoMiao (Tomato). Data packet: 0x28, len(2), index(2), uid(8), battery, fw(2), hw(2), FRAM(344), 0x29, [patchInfo(6)]. */
export class MiaoMiaoTransmitter {
    shortTransmitterName = 'miaomiao';
    requiresDelayedReconnect = true;
    rxBuffer = new Uint8Array(0);
    static canSupportPeripheral(name) {
        return name?.toLowerCase().startsWith('miaomiao') ?? false;
    }
    reset() {
        this.rxBuffer = new Uint8Array(0);
    }
    /** `requestData`: confirms the sensor (0xD301), resets, then requests data (0xF0). */
    requestData() {
        const writes = [MiaoMiaoTransmitter.confirmSensorCommand()];
        this.reset();
        writes.push(new Uint8Array([0xf0]));
        return writes;
    }
    static confirmSensorCommand() {
        return new Uint8Array([0xd3, 0x01]);
    }
    onNotify(value, now) {
        this.rxBuffer = appendBytes(this.rxBuffer, value);
        // The MiaoMiao does not repeat the first byte in follow-up telegrams, so it acts as message state.
        switch (this.rxBuffer[0]) {
            case 0x28: {
                if (this.rxBuffer.length < MIAOMIAO_PACKET_LENGTH)
                    return { writes: [] };
                const packet = this.handleCompleteMessage(now);
                this.reset();
                return packet ? { writes: [], packet } : { writes: [] };
            }
            case 0x32:
                this.reset();
                return { writes: [MiaoMiaoTransmitter.confirmSensorCommand()], event: 'newSensor' };
            case 0x34:
                this.reset();
                return { writes: [], event: 'noSensor' };
            case 0xd1:
                // value[2] is 0x01 on success, 0x00 on failure; the Swift code ignores both.
                this.reset();
                return { writes: [], event: 'frequencyChanged' };
            default:
                this.reset();
                return { writes: [] };
        }
    }
    handleCompleteMessage(now) {
        const rx = this.rxBuffer;
        if (rx.length < MIAOMIAO_PACKET_LENGTH)
            return null;
        const patchInfo = rx.length >= MIAOMIAO_WITH_PATCHINFO_LENGTH ? rx.slice(363, 369) : null;
        const uid = rx.slice(5, 13);
        const metadata = {
            hardware: hex(rx.subarray(16, 18)),
            firmware: hex(rx.subarray(14, 16)),
            battery: rx[13],
            name: this.shortTransmitterName,
            macAddress: null,
            patchInfo,
            uid,
        };
        const sensorData = SensorData.create(uid, rx.slice(18, 362), now, patchInfo);
        return sensorData ? { sensorData, metadata } : null;
    }
}
const BubbleResponse = { dataPacket: 130, bubbleInfo: 128, noSensor: 191, serialNumber: 192, patchInfo: 193 };
const BUBBLE_PACKET_LENGTH = 352;
/** Bubble: same UART service as the MiaoMiao but a different byte protocol. */
export class BubbleTransmitter extends MiaoMiaoTransmitter {
    shortTransmitterName = 'bubble';
    battery = null;
    patchInfo = null;
    uid = null;
    details;
    constructor(manufacturerData = null) {
        super();
        this.details = getBubbleDetailsFromAdvertisement(manufacturerData);
    }
    static canSupportPeripheral(name) {
        return name?.toLowerCase().startsWith('bubble') ?? false;
    }
    /** `requestData`: ask for a transmission every five minutes. */
    requestData() {
        this.reset();
        return [new Uint8Array([0x00, 0x00, 0x05])];
    }
    onNotify(value, now) {
        switch (value[0]) {
            case BubbleResponse.bubbleInfo:
                this.battery = value[4] ?? null;
                return { writes: [new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x2b])] };
            case BubbleResponse.dataPacket: {
                this.rxBuffer = appendBytes(this.rxBuffer, value.subarray(4));
                if (this.rxBuffer.length < BUBBLE_PACKET_LENGTH)
                    return { writes: [] };
                const packet = this.handleCompleteMessage(now);
                this.reset();
                return packet ? { writes: [], packet } : { writes: [] };
            }
            case BubbleResponse.noSensor:
                this.reset();
                return { writes: [], event: 'noSensor' };
            case BubbleResponse.serialNumber:
                if (value.length < 10)
                    return { writes: [] };
                this.reset();
                this.uid = value.slice(2, 10);
                this.rxBuffer = value.slice(2, 10); // "for historical reasons" the uid leads the buffer
                return { writes: [] };
            case BubbleResponse.patchInfo:
                // Swift guards `count >= 10` but reads 5..<11; require 11 bytes so we never read past the end.
                if (value.length < 11)
                    return { writes: [] };
                this.patchInfo = value.slice(5, 11);
                return { writes: [] };
            default:
                return { writes: [] };
        }
    }
    handleCompleteMessage(now) {
        const rx = this.rxBuffer;
        if (rx.length < BUBBLE_PACKET_LENGTH)
            return null;
        const metadata = {
            hardware: this.details.hardware ?? 'unknown',
            firmware: this.details.firmware ?? 'unknown',
            battery: this.battery ?? 100,
            name: this.shortTransmitterName,
            macAddress: this.details.mac,
            patchInfo: this.patchInfo,
            uid: this.uid,
        };
        const sensorData = SensorData.create(rx.slice(0, 8), rx.slice(8, 352), now, this.patchInfo);
        return sensorData ? { sensorData, metadata } : null;
    }
}
/** `BubbleTransmitter.getDeviceDetailsFromAdvertisementInternal`. */
export function getBubbleDetailsFromAdvertisement(data) {
    if (!data || data.length < 12)
        return { mac: null, firmware: null, hardware: null };
    const h = (i) => data[i].toString(16).padStart(2, '0');
    const mac = [7, 6, 5, 4, 3, 2].map((i) => h(i).toUpperCase()).join(':');
    // Swift: Float("08.02")?.description -> "8.02"
    const version = (a, b) => {
        const text = `${h(a)}.${h(b)}`;
        return /^\d+\.\d+$/.test(text) ? String(Number.parseFloat(text)) : null;
    };
    return { mac, firmware: version(8, 9), hardware: version(10, 11) };
}
