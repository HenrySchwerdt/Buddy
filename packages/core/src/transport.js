/**
 * Hardware transports. Drivers depend only on these interfaces; the app injects a
 * react-native-ble-plx / NFC implementation and tests inject in-memory fakes, so every
 * driver's protocol logic runs in plain Node tests.
 */
export function createMemorySecretStore(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get: async (k) => map.get(k) ?? null,
        set: async (k, v) => {
            if (v === null)
                map.delete(k);
            else
                map.set(k, v);
        },
    };
}
// ── byte helpers shared by drivers ─────────────────────────────────────────────
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(s) {
    const clean = s.replace(/[^0-9a-f]/gi, '');
    if (clean.length % 2)
        throw new Error(`Odd-length hex: ${s}`);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}
export const concatBytes = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
};
export const u16le = (b, o) => (b[o] | (b[o + 1] << 8)) >>> 0;
export const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
export const i16le = (b, o) => (u16le(b, o) << 16) >> 16;
export const u16be = (b, o) => ((b[o] << 8) | b[o + 1]) >>> 0;
export const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const writeU16le = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
export const writeU32le = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — used by Dexcom and others. */
export function crc16CcittFalse(data, init = 0xffff) {
    let crc = init;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++)
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}
