/**
 * TypeScript port of `LibreSensor/SensorPairing/SensorPairingService.swift`,
 * `LibreSensor/SensorPairing/SensorPairing.swift` and the result handling of
 * `LibreTransmitterUI/Views/Setup/Libre2DirectSetup.swift` (`receivePairingInfo`) from
 * loopandlearn/LibreTransmitter (MIT, (c) Reimar Metzen and the LibreTransmitter authors).
 *
 * NFC flow for a Libre 2 (EU) sensor: read patch info (0xA1), read the 43 FRAM blocks, send
 * "enable streaming" (0xA1 sub-command 0x1E, unlock code 42), which returns the BLE MAC, then
 * decrypt the FRAM and keep sensor UID, patch info and factory calibration for the BLE session.
 * The sensor must already be activated and warmed up (the Swift code never activates sensors).
 */
import { hex } from '@buddy/core';
import { usefulFunction, decryptFram } from './libre2-crypto';
import { LIBRE2_UNLOCK_CODE } from './libre2-direct';
import { SensorData, FRAM_LENGTH } from './sensor-data';
import { sensorTypeFromPatchInfo } from './sensor-type';
import { LIBRE_SECRET_KEYS, calibrationStore, saveCalibrationMapping, saveLibre2Sensor } from './storage';
const PAIRING_ERROR_TEXT = {
    noTagInfo: 'Could not get tag info',
    noSensorData: 'Could not get sensor data',
    wrongSensorType: 'Wrong sensor type detected',
    decryptionError: 'Could not decrypt sensor contents',
    noPatchInfo: 'Could not get patch info',
    nfcNotSupported: 'Phone NFC not supported!',
};
export class PairingError extends Error {
    code;
    constructor(code, detail) {
        super(detail ? `${PAIRING_ERROR_TEXT[code]}: ${detail}` : PAIRING_ERROR_TEXT[code]);
        this.code = code;
        this.name = 'PairingError';
    }
}
const FRAM_BLOCKS = 43;
const ENABLE_STREAMING = 0x1e;
export const PAIRING_ALERT = 'Hold the top of your iPhone near the sensor to pair';
/**
 * CoreNFC returns the identifier MSB first (`E0 07 ...`) and the Swift code reverses it. We
 * accept either order: a UID that already ends in `E0` is taken as-is.
 */
export function normalizeSensorUid(tagUid) {
    if (tagUid.length === 8 && tagUid[7] === 0xe0)
        return tagUid.slice();
    return tagUid.slice().reverse();
}
/** `nfcCommand(.enableStreaming, unlockCode:patchInfo:sensorUID:)` parameters for custom command 0xA1. */
export function enableStreamingParameters(sensorUid, patchInfo, unlockCode = LIBRE2_UNLOCK_CODE) {
    const b = [unlockCode & 0xff, (unlockCode >>> 8) & 0xff, (unlockCode >>> 16) & 0xff, (unlockCode >>> 24) & 0xff];
    const y = ((patchInfo[4] | (patchInfo[5] << 8)) ^ ((b[1] << 8) + b[0])) & 0xffff;
    const d = usefulFunction(sensorUid, ENABLE_STREAMING, y);
    return new Uint8Array([ENABLE_STREAMING, ...b, ...d]);
}
async function readFram(tag) {
    const blocks = [];
    for (let i = 0; i < FRAM_BLOCKS; i++) {
        try {
            blocks.push(await tag.readSingleBlock(i));
        }
        catch {
            // Swift skips failed reads and then fails on the total length.
        }
    }
    const fram = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of blocks) {
        fram.set(b, o);
        o += b.length;
    }
    return fram;
}
async function scanTag(tag) {
    let patchInfo;
    try {
        patchInfo = await tag.customCommand(0xa1, new Uint8Array(0));
    }
    catch (e) {
        throw new PairingError('noPatchInfo', e.message);
    }
    const fram = await readFram(tag);
    const sensorUid = normalizeSensorUid(tag.uid);
    if (patchInfo.length < 6)
        throw new PairingError('noPatchInfo');
    let response = new Uint8Array(0);
    try {
        response = await tag.customCommand(0xa1, enableStreamingParameters(sensorUid, patchInfo));
    }
    catch {
        // Swift ignores the error and treats streaming as not enabled.
    }
    const streamingEnabled = response.length === 6;
    const macAddress = streamingEnabled ? hex(response.slice().reverse()).toUpperCase() : null;
    if (sensorUid.length !== 8 || patchInfo.length !== 6 || fram.length !== FRAM_LENGTH)
        throw new PairingError('noSensorData');
    const sensorType = sensorTypeFromPatchInfo(patchInfo);
    if (sensorType !== 'Libre 2')
        throw new PairingError('wrongSensorType', sensorType);
    let decrypted;
    try {
        decrypted = decryptFram(sensorType, sensorUid, patchInfo, fram);
    }
    catch (e) {
        throw new PairingError('decryptionError', e.message);
    }
    const sensorData = SensorData.create(sensorUid, decrypted, 0, patchInfo);
    // Not in Swift: refuse to derive calibration from a FRAM that does not decrypt to valid CRCs.
    if (!sensorData || !sensorData.hasValidCRCs)
        throw new PairingError('decryptionError', 'FRAM CRC mismatch after decryption');
    return {
        uid: sensorUid,
        patchInfo: patchInfo.slice(),
        fram: decrypted,
        streamingEnabled,
        macAddress,
        serialNumber: sensorData.serialNumber,
        sensorType,
        calibration: sensorData.calibrationData,
        maxMinutesWearTime: sensorData.maxMinutesWearTime,
    };
}
/**
 * Pairs a Libre 2 (EU) sensor over NFC and stores UID, patch info, MAC, unlock counter and
 * factory calibration in `ctx.secrets` for the `libre-2-direct` CGM source.
 */
export async function pairSensor(ctx) {
    const { nfc, secrets } = ctx;
    if (!nfc)
        throw new Error('Libre 2 pairing needs NFC (ctx.nfc is missing)');
    if (!secrets)
        throw new Error('Libre 2 pairing needs a secret store (ctx.secrets is missing)');
    if (!(await nfc.isSupported()))
        throw new PairingError('nfcNotSupported');
    const info = await nfc.withIso15693Tag(PAIRING_ALERT, scanTag);
    if (!info.streamingEnabled)
        ctx.log?.warn('Libre 2: enable-streaming returned no MAC address; BLE discovery falls back to manufacturer data');
    // receivePairingInfo: calibration must always come from the full NFC scan
    await calibrationStore(secrets, LIBRE_SECRET_KEYS.libre2Calibration).set(info.calibration);
    await saveCalibrationMapping(secrets, { uuidHex: hex(info.uid), reverseFooterCRC: info.calibration.isValidForFooterWithReverseCRCs });
    const sensor = {
        uid: info.uid,
        patchInfo: info.patchInfo,
        maxAge: info.maxMinutesWearTime,
        unlockCount: 0,
        macAddress: info.macAddress,
        serialNumber: info.serialNumber,
    };
    await saveLibre2Sensor(secrets, sensor);
    // the BLE peripheral id is unknown until the next scan finds this UID
    await secrets.set(LIBRE_SECRET_KEYS.libre2DeviceId, null);
    ctx.log?.info(`Libre 2 sensor ${info.serialNumber} paired`);
    return info;
}
