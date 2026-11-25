/**
 * TypeScript port of `TransmitterID` (Transmitter.swift) and AESCrypt.m from
 * loopandlearn/CGMBLEKit (MIT, © 2015 Nathan Racklyeft).
 *
 * The transmitter proves it knows the ID by hashing our random token, and we prove the same
 * by hashing its challenge: hash = AES-128-ECB(key = "00{ID}00{ID}", data = token‖token)[0..<8].
 */
import { ecb } from '@noble/ciphers/aes.js';
/** Six characters, digits and upper-case letters (e.g. "8G1234"). */
export const TRANSMITTER_ID_PATTERN = /^[0-9A-Z]{6}$/;
export function normalizeTransmitterId(raw) {
    const id = raw.trim().toUpperCase();
    if (!TRANSMITTER_ID_PATTERN.test(id))
        throw new Error('Dexcom transmitter ID must be 6 letters/digits (printed on the transmitter)');
    return id;
}
const cryptKey = (id) => new TextEncoder().encode(`00${id}00${id}`);
/** Returns the 8-byte hash of an 8-byte token/challenge, or `null` for wrong-sized input. */
export function computeHash(id, data) {
    if (data.length !== 8)
        return null;
    const key = cryptKey(id);
    if (key.length !== 16)
        return null;
    const doubled = new Uint8Array(16);
    doubled.set(data, 0);
    doubled.set(data, 8);
    // CCCrypt(kCCOptionECBMode) without PKCS7: exactly one block in, one block out.
    const out = ecb(key, { disablePadding: true }).encrypt(doubled);
    return out.slice(0, 8);
}
