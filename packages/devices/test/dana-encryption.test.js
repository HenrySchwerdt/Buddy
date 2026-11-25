/**
 * Ported from DanaKitTests/Encryption/{CommonTests,CrcTests,DecryptionTests,EncryptTests}.swift
 * of loopandlearn/DanaKit (MIT, © original authors). Same bytes as the Swift tests.
 */
import { describe, expect, it } from 'vitest';
import { ble5RandomKeysFrom, DanaDecryptError, DanaKitEncryption, decrypt, decryptionRandomSyncKey, decryptSecondLevel, encodePacketSerialNumber, encrypt, encryptionRandomSyncKey, encryptSecondLevel, generateCrc, initialRandomSyncKey, } from '../src/dana/encryption';
import { DanaPacketType } from '../src/dana/packet-type';
const DEVICE_NAME = 'VJH00012FI';
// 54, 54, 54, 56, 54, 54
const Ble5Keys = [44, 27, 44];
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const B = (a) => new Uint8Array(a);
const EMPTY = new Uint8Array(0);
const encParams = (operationCode, data, enhancedEncryption) => ({
    operationCode,
    data: data ? B(data) : null,
    deviceName: DEVICE_NAME,
    enhancedEncryption,
    timeSecret: EMPTY,
    passwordSecret: EMPTY,
    passKeySecret: EMPTY,
});
describe('Dana common utils (CommonTests.swift)', () => {
    it('encodePacketSerialNumber', () => {
        // Pump check command
        const message = B([165, 165, 12, 1, 0, ...ascii(DEVICE_NAME), 188, 122, 90, 90]);
        expect(Array.from(encodePacketSerialNumber(message, DEVICE_NAME))).toEqual([
            165, 165, 12, 233, 243, 217, 162, 187, 191, 216, 195, 190, 218, 181, 198, 84, 137, 90, 90,
        ]);
    });
    it('decryptionRandomSyncKey inverts encryptionRandomSyncKey for every key', () => {
        const rpk = B([181, 201, 65]);
        for (let k = 0; k < 256; k++)
            expect(decryptionRandomSyncKey(encryptionRandomSyncKey(k, rpk), rpk)).toBe(k);
    });
    it('BLE5 key "666866" maps to the random keys used by the Swift tests', () => {
        expect(ble5RandomKeysFrom(B([54, 54, 54, 56, 54, 54]))).toEqual(Ble5Keys);
        expect(ble5RandomKeysFrom(B([54, 54, 0, 56, 54, 54]))).toBeNull();
    });
});
describe('Dana CRC (CrcTests.swift)', () => {
    it('enhancedEncryption 0, encryption command', () => {
        // pump_check command
        expect(generateCrc(B([1, 0, ...ascii(DEVICE_NAME)]), 0, true)).toBe(0xbc7a);
    });
    it('enhancedEncryption 1, normal command', () => {
        // BasalSetTemporary command (200%, 1 hour)
        expect(generateCrc(B([161, 96, 200, 1]), 1, false)).toBe(0x33fd);
    });
    it('enhancedEncryption 1, encryption command', () => {
        // TIME_INFORMATION command -> sendTimeInfo
        expect(generateCrc(B([1, 1]), 1, true)).toBe(0x0990);
    });
    it('enhancedEncryption 2, normal command', () => {
        expect(generateCrc(B([161, 96, 200, 1]), 2, false)).toBe(0x7a1a);
    });
    it('enhancedEncryption 2, encryption command', () => {
        // TIME_INFORMATION command -> sendBLE5PairingInformation
        expect(generateCrc(B([1, 1, 0, 0, 0, 0]), 2, true)).toBe(0x1fef);
    });
});
describe('Dana decryption (DecryptionTests.swift)', () => {
    const params = (data) => ({
        data: B(data),
        deviceName: DEVICE_NAME,
        enhancedEncryption: 2,
        isEncryptionMode: true,
        pairingKeyLength: 0,
        randomPairingKeyLength: 0,
        ble5KeyLength: 0,
        timeSecret: EMPTY,
        passwordSecret: EMPTY,
        passKeySecret: EMPTY,
        passKeySecretBackup: EMPTY,
    });
    it('decrypts a BLE5 PUMP_CHECK response', () => {
        const r = decrypt(params([165, 165, 14, 234, 243, 192, 163, 190, 134, 184, 225, 185, 222, 197, 183, 222, 197, 31, 241, 90, 90]));
        expect(r.isEncryptionMode).toBe(true);
        expect(r.passKeySecret.length).toBe(0);
        expect(r.passKeySecretBackup.length).toBe(0);
        expect(r.passwordSecret.length).toBe(0);
        expect(r.timeSecret.length).toBe(0);
        expect(Array.from(r.data)).toEqual([2, 0, 79, 75, 77, 9, 80, 18, 54, 54, 54, 56, 54, 54]);
    });
    it('throws if the length does not match', () => {
        expect(() => decrypt(params([165, 165, 17, 234, 243, 192, 163, 190, 134, 184, 225, 185, 222, 197, 183, 222, 197, 31, 241, 90, 90]))).toThrow(new DanaDecryptError('Package length does not match the length attr.'));
    });
    it('throws if the CRC fails', () => {
        expect(() => decrypt(params([165, 165, 14, 234, 243, 192, 163, 190, 134, 184, 225, 185, 222, 197, 183, 222, 197, 31, 21, 90, 90]))).toThrow(new DanaDecryptError('Crc checksum failed...'));
    });
    it('decodePacket returns an empty array instead of throwing', () => {
        const enc = new DanaKitEncryption();
        enc.setEnhancedEncryption(2);
        expect(enc.decodePacket(B([165, 165, 17, 0, 0, 0, 0, 0, 0, 0]), DEVICE_NAME).length).toBe(0);
    });
});
describe('Dana encryption (EncryptTests.swift)', () => {
    const cases = [
        ['PUMP_CHECK', DanaPacketType.OPCODE_ENCRYPTION__PUMP_CHECK, null, 0, true, [165, 165, 12, 233, 243, 217, 162, 187, 191, 216, 195, 190, 218, 181, 198, 84, 137, 90, 90]],
        ['TIME_INFORMATION', DanaPacketType.OPCODE_ENCRYPTION__TIME_INFORMATION, [0, 0, 0, 0], 0, true, [165, 165, 6, 233, 242, 143, 232, 243, 143, 247, 28, 90, 90]],
        ['TIME_INFORMATION (BLE5)', DanaPacketType.OPCODE_ENCRYPTION__TIME_INFORMATION, [0, 0, 0, 0], 2, true, [165, 165, 6, 233, 242, 143, 229, 226, 137, 183, 82, 90, 90]],
        ['TIME_INFORMATION (empty)', DanaPacketType.OPCODE_ENCRYPTION__TIME_INFORMATION, [], 0, true, [165, 165, 2, 233, 242, 134, 120, 90, 90]],
        ['GET_PUMP_CHECK', DanaPacketType.OPCODE_ENCRYPTION__GET_PUMP_CHECK, [], 0, true, [165, 165, 2, 233, 0, 81, 109, 90, 90]],
        ['GET_EASYMENU_CHECK', DanaPacketType.OPCODE_ENCRYPTION__GET_EASYMENU_CHECK, [], 0, true, [165, 165, 2, 233, 7, 33, 82, 90, 90]],
        ['PASSKEY_REQUEST', DanaPacketType.OPCODE_ENCRYPTION__PASSKEY_REQUEST, [], 0, true, [165, 165, 2, 233, 34, 80, 77, 90, 90]],
        ['CHECK_PASSKEY', DanaPacketType.OPCODE_ENCRYPTION__CHECK_PASSKEY, [1, 2], 0, true, [165, 165, 4, 233, 35, 228, 128, 28, 180, 90, 90]],
        ['SET_TEMPORARY_BASAL (BLE5)', DanaPacketType.OPCODE_BASAL__SET_TEMPORARY_BASAL, [200, 1], 2, false, [165, 165, 4, 73, 147, 71, 233, 137, 149, 90, 90]],
        ['INITIAL_SCREEN_INFORMATION (BLE5)', DanaPacketType.OPCODE_REVIEW__INITIAL_SCREEN_INFORMATION, [], 2, false, [165, 165, 2, 73, 241, 235, 35, 90, 90]],
    ];
    it.each(cases)('encodes %s', (_name, opCode, data, mode, isEncryptionMode, expected) => {
        const r = encrypt(encParams(opCode, data, mode));
        expect(r.isEncryptionMode).toBe(isEncryptionMode);
        expect(Array.from(r.data)).toEqual(expected);
    });
    const pairingKey = B([237, 241, 117, 95, 135, 61]);
    const randomPairingKey = B([181, 201, 65]);
    const second = (buffer, randomSyncKey, enhancedEncryption = 1) => ({
        buffer: B(buffer),
        enhancedEncryption,
        pairingKey,
        randomPairingKey,
        randomSyncKey,
        bleRandomKeys: Ble5Keys,
    });
    it('second level RSv3: KEEP_CONNECTION', () => {
        // DANA_PACKET_TYPE.ETC__KEEP_CONNECTION
        const r = encryptSecondLevel(second([165, 165, 2, 65, 9, 176, 75, 90, 90], initialRandomSyncKey(pairingKey)));
        expect(r.randomSyncKey).toBe(207);
        expect(Array.from(r.buffer)).toEqual([19, 203, 1, 47, 8, 203, 194, 168, 207]);
    });
    it('second level RSv3: multiple messages share the chained sync key', () => {
        let randomSyncKey = initialRandomSyncKey(pairingKey);
        const r1 = encryptSecondLevel(second([165, 165, 2, 65, 9, 176, 75, 90, 90], randomSyncKey));
        expect(r1.randomSyncKey).toBe(207);
        expect(Array.from(r1.buffer)).toEqual([19, 203, 1, 47, 8, 203, 194, 168, 207]);
        randomSyncKey = r1.randomSyncKey;
        // Decrypt ETC__KEEP_CONNECTION
        const r2 = decryptSecondLevel(second([83, 143, 118, 179, 100, 46, 5, 39, 50, 225], randomSyncKey));
        expect(r2.randomSyncKey).toBe(225);
        expect(Array.from(r2.buffer)).toEqual([165, 165, 3, 82, 9, 136, 174, 2, 90, 90]);
        randomSyncKey = r2.randomSyncKey;
        // DANA_PACKET_TYPE.REVIEW__GET_SHIPPING_INFORMATION
        const r3 = encryptSecondLevel(second([165, 165, 2, 65, 214, 138, 205, 90, 90], randomSyncKey));
        expect(r3.randomSyncKey).toBe(177);
        expect(Array.from(r3.buffer)).toEqual([70, 81, 52, 121, 145, 240, 177, 76, 177]);
    });
    it('second level BLE5: INITIAL_SCREEN_INFORMATION', () => {
        const r = encryptSecondLevel({ ...second([165, 165, 2, 73, 241, 235, 35, 90, 90], 0, 2), pairingKey: EMPTY, randomPairingKey: EMPTY });
        expect(r.randomSyncKey).toBe(0);
        expect(Array.from(r.buffer)).toEqual([126, 126, 235, 16, 154, 122, 245, 170, 170]);
    });
    it('second level decrypt inverts encrypt (RSv3 and BLE5)', () => {
        const msg = [165, 165, 4, 73, 147, 71, 233, 137, 149, 90, 90];
        for (const mode of [1, 2]) {
            const e = encryptSecondLevel(second(msg, 42, mode));
            const d = decryptSecondLevel(second(Array.from(e.buffer), 42, mode));
            // BLE5 does not restore the A5/5A markers (DanaKit accepts AA/EE as start/end bytes instead)
            const expected = mode === 1 ? msg : [0xaa, 0xaa, ...msg.slice(2, -2), 0xee, 0xee];
            expect(Array.from(d.buffer)).toEqual(expected);
            expect(d.randomSyncKey).toBe(e.randomSyncKey);
        }
    });
});
