/**
 * TypeScript port of `SensorData.readBits` / `SensorData.writeBits` from
 * `LibreSensor/SensorContents/SensorData.swift` (loopandlearn/LibreTransmitter, MIT,
 * (c) Uwe Petersen and the LibreTransmitter authors). Little-endian bit fields as used in
 * Libre FRAM and the Libre 2 BLE payload.
 */
/** Reads `bitCount` bits starting at `byteOffset * 8 + bitOffset` (LSB first). */
export function readBits(buffer, byteOffset, bitOffset, bitCount) {
    let res = 0;
    for (let i = 0; i < bitCount; i++) {
        const totalBitOffset = byteOffset * 8 + bitOffset + i;
        const byte = buffer[Math.floor(totalBitOffset / 8)];
        if (byte === undefined)
            throw new RangeError(`readBits: bit ${totalBitOffset} outside buffer of ${buffer.length} bytes`);
        if (totalBitOffset >= 0 && ((byte >> (totalBitOffset % 8)) & 1) === 1)
            res |= 1 << i;
    }
    return res;
}
/** Returns a copy of `buffer` with `bitCount` bits of `value` written at the given offset. */
export function writeBits(buffer, byteOffset, bitOffset, bitCount, value) {
    const res = buffer.slice();
    for (let i = 0; i < bitCount; i++) {
        const totalBitOffset = byteOffset * 8 + bitOffset + i;
        const byte = Math.floor(totalBitOffset / 8);
        const bit = totalBitOffset % 8;
        const current = res[byte];
        if (current === undefined)
            throw new RangeError(`writeBits: bit ${totalBitOffset} outside buffer of ${buffer.length} bytes`);
        res[byte] = (current & ~(1 << bit)) | (((value >> i) & 1) << bit);
    }
    return res;
}
