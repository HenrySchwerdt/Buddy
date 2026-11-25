/**
 * Protocol tests for the TypeScript port of loopandlearn/LibreTransmitter (MIT, (c) the
 * LibreTransmitter authors).
 *
 * The Swift package's own test target (`LibreTransmitterTests.swift`) is an empty Xcode
 * template, so the expected values here were produced by compiling the original Swift sources
 * (CRC, Measurement, SensorData, SensorSerialNumber, PreLibre2, GlucoseFromRaw, GlucoseSmoothing,
 * LibreGlucose) with `swiftc` and running them on the real byte vectors shipped in
 * `PreLibre2.swift` (`Libre2.Example`, `Libre2.Example2`, `Libre2.BLEExample`), with the read
 * date fixed at 1_700_000_040 s.
 */
import { fromHex, hex } from '@buddy/core';
import { describe, expect, it } from 'vitest';
import { CRC16_TABLE, libreCrc16 } from '../src/libre/crc';
import { LIBRE2_BLE_EXAMPLE, LIBRE2_EXAMPLE, LIBRE2_EXAMPLE2 } from '../src/libre/examples';
import { fromHistoryMeasurements, fromTrendMeasurements, getGlucoseTrend } from '../src/libre/libre-glucose';
import { activateParameters, decryptBle, decryptFram, parseBleData, streamingUnlockPayload } from '../src/libre/libre2-crypto';
import { calibratedGlucose, glucoseValueFromRaw, MeasurementError } from '../src/libre/measurement';
import { enableStreamingParameters, normalizeSensorUid } from '../src/libre/pairing';
import { predictBloodSugar, SensorData, sensorSerialNumber } from '../src/libre/sensor-data';
import { sensorTypeFromPatchInfo } from '../src/libre/sensor-type';
import { canSupportLibre2Peripheral, LimitedQueue, matchesLibre2Advertisement, verifyLibre2ManufacturerData } from '../src/libre/libre2-direct';
import { getBubbleDetailsFromAdvertisement } from '../src/libre/transmitters';
const READ_DATE = 1_700_000_040_000;
const GOLDEN = {
    example1: {
        decrypted: '24fad01a030000000000000000000000000000000000000013ba0f0f7b0500b05980750500a05980690500945980610500b459805e0500b05980580500bc59804c0508f259804d0500c85980480500b01980410508a259803805009859802e05009859802a0500585980250500745980220500985980880500b85980a60800e85980f108005c5a804109003c59807c0900ec5880bb0800dc5980ac08009c5a802a0800345a80db0700ec59805a0700105a808f0600485a80a70500585a807f0500245980fc0400f859809e0500c059807e0500b05980aa0600a05980e406004059801707004c59800f07007859809907009c5980f908000c5980b10900405a80b30800cc5980f00700205a804b0700945a808f0600905980f905009c5a808a0500445a804705002c5a809a0500085a809506007459807f0700545980502801008e7f3001b609ef50140396805a00cda60e741a000024996c',
        serial: '3MH001HM1LM',
        minutesSinceStart: 10320,
        maxMinutesWearTime: 20719,
        nextTrendBlock: 15,
        nextHistoryBlock: 15,
        footerCrc: 36479,
        calibration: { i1: 0, i2: 858, i3: 14, i4: 6772, i5: 9360, i6: 6948, extraSlope: 1, extraOffset: 0, isValidForFooterWithReverseCRCs: 32654 },
        trend0: { rawGlucose: 1314, rawTemperature: 6552, rawTemperatureAdjustment: -4 },
        trendFromRaw0: 99.05785520846342,
        trendCal: [99, 99, 99, 100, 101, 102, 103, 104, 104, 104, 105, 105, 105, 106, 107, 109],
        trendSmoothed: [99.6, 100.2, 101, 102, 102.8, 103.4, 104, 104.4, 104.6, 105, 105.6, 106.4, 106.75, 107.33333333333333, 108, 108],
        trendErrorIdx: [5, 8],
        histCal: [107, 111, 97, 105, 114, 135, 151, 162, 171, 185, 181, 191, 188, 190, 180, 150, 131, 112, 105, 111, 123, 131, 153, 165, 180, 206, 180, 154, 141, 141, 136, 133],
        histFromRaw0: 107.49902166654368,
        hist0: { date: 1_699_999_140_000, counter: 10305 },
        hist31: { date: 1_699_971_240_000, counter: 9840 },
        histErrorIdx: [],
        prediction: { raw: 1245, calibrated: 93 },
    },
    example2: {
        decrypted: '815a101c030000000000000000000000000000000000000008da0213480500849600430500b896008305005c96008305005c96007505006496006d05005c960072050068d6007d05005c96007705005096006b05004096006105003896006905083696006505003496005105002496004b05003496004e0500509600c30700849600210800d4d500f10600d496006f0500ec9600890500149900950500c89800d505088698007106083298009b06008c5800d00600585800a80600249800b605002898001705000c9800f10400dc97005805003458009d05005897008f0500d496008a05008c96005805003496000e04089e5800c303000098007a0400189700f80400c89700420400409800150400649800710400fc97007104005097002f04083e58008604082a9800c10408c657009e06006097002c0700309700620c010071c63001ca091751140396805a00cda618a31a0000b2c860',
        serial: '3MH001GJ0VW',
        minutesSinceStart: 3170,
        maxMinutesWearTime: 20759,
        nextTrendBlock: 2,
        nextHistoryBlock: 19,
        footerCrc: 29126,
        calibration: { i1: 0, i2: 898, i3: 24, i4: 6819, i5: 8904, i6: 6192, extraSlope: 1, extraOffset: 0, isValidForFooterWithReverseCRCs: 50801 },
        trend0: { rawGlucose: 1347, rawTemperature: 5816, rawTemperatureAdjustment: 8 },
        trendFromRaw0: 94.94210445909484,
        trendCal: [95, 94, 94, 93, 93, 95, 96, 95, 96, 97, 98, 97, 97, 97, 98, 98],
        trendSmoothed: [93.8, 93.8, 94.2, 94.4, 95, 95.8, 96.4, 96.6, 97, 97.2, 97.4, 97.4, 97.5, 97.66666666666667, 98, 98],
        trendErrorIdx: [6],
        histCal: [94, 100, 102, 105, 104, 93, 97, 112, 133, 137, 134, 128, 116, 112, 112, 100, 131, 149, 146, 138, 127, 89, 85, 78, 80, 83, 76, 80, 93, 80, 68, 76],
        histFromRaw0: 94.22512803691272,
        hist0: { date: 1_699_999_740_000, counter: 3165 },
        hist31: { date: 1_699_971_840_000, counter: 2700 },
        histErrorIdx: [11, 12, 21, 22, 23, 31],
        prediction: { raw: 1309, calibrated: 92 },
    },
};
describe('Libre CRC (CRC.swift)', () => {
    it('generates the same table as the hard-coded Swift table', () => {
        expect(CRC16_TABLE.slice(0, 8)).toEqual([0, 4489, 8978, 12955, 17956, 22445, 25910, 29887]);
        expect(CRC16_TABLE[255]).toBe(3960);
    });
    it('matches Crc.crc16("123456789", seed: 0xffff)', () => {
        expect(libreCrc16(new TextEncoder().encode('123456789'), 0xffff)).toBe(63113);
    });
});
describe.each([
    ['example1', LIBRE2_EXAMPLE, GOLDEN.example1],
    ['example2', LIBRE2_EXAMPLE2, GOLDEN.example2],
])('Libre 2 FRAM %s (PreLibre2.swift + SensorData.swift)', (_name, vector, g) => {
    const uid = fromHex(vector.sensorId);
    const info = fromHex(vector.sensorInfo);
    const decrypted = decryptFram(sensorTypeFromPatchInfo(info), uid, info, fromHex(vector.buffer));
    const sd = SensorData.create(uid, decrypted, READ_DATE + 17_000, info);
    const cal = sd.calibrationData;
    it('decrypts to the same bytes as Libre2.decryptFRAM with valid header/body/footer CRCs', () => {
        expect(sensorTypeFromPatchInfo(info)).toBe('Libre 2');
        expect(hex(decrypted)).toBe(g.decrypted);
        expect([sd.hasValidHeaderCRC, sd.hasValidBodyCRC, sd.hasValidFooterCRC]).toEqual([true, true, true]);
        expect(sd.isLikelyLibre1FRAM).toBe(true);
    });
    it('parses header/body/footer fields and the serial number', () => {
        expect(sd.date).toBe(READ_DATE); // rounded down to the minute
        expect(sd.state).toBe('ready');
        expect(sd.serialNumber).toBe(g.serial);
        expect(sd.minutesSinceStart).toBe(g.minutesSinceStart);
        expect(sd.maxMinutesWearTime).toBe(g.maxMinutesWearTime);
        expect(sd.nextTrendBlock).toBe(g.nextTrendBlock);
        expect(sd.nextHistoryBlock).toBe(g.nextHistoryBlock);
        expect(sd.footerCrc).toBe(g.footerCrc);
        expect(cal).toEqual(g.calibration);
    });
    it('decodes trend records and temperature-compensated glucose', () => {
        const trends = sd.trendMeasurements();
        expect(trends).toHaveLength(16);
        expect(trends[0]).toMatchObject(g.trend0);
        expect(trends[1].date).toBe(READ_DATE - 60_000);
        expect(glucoseValueFromRaw(trends[0], cal)).toBeCloseTo(g.trendFromRaw0, 9);
        expect(trends.map((m) => calibratedGlucose(m, cal))).toEqual(g.trendCal);
        expect(trends.flatMap((m, i) => (m.error.some((e) => e !== MeasurementError.OK) ? [i] : []))).toEqual(g.trendErrorIdx);
        const smoothed = fromTrendMeasurements(trends, cal);
        smoothed.forEach((s, i) => expect(s.glucoseDouble).toBeCloseTo(g.trendSmoothed[i], 9));
        expect(getGlucoseTrend(smoothed[0], smoothed[smoothed.length - 1])).toBe('flat');
        const prediction = predictBloodSugar(trends, 10);
        expect(prediction.rawGlucose).toBe(g.prediction.raw);
        expect(calibratedGlucose(prediction, cal)).toBe(g.prediction.calibrated);
    });
    it('decodes history records with dates and minute counters', () => {
        const history = sd.historyMeasurements();
        expect(history).toHaveLength(32);
        expect({ date: history[0].date, counter: history[0].counter }).toEqual(g.hist0);
        expect({ date: history[31].date, counter: history[31].counter }).toEqual(g.hist31);
        expect(glucoseValueFromRaw(history[0], cal)).toBeCloseTo(g.histFromRaw0, 9);
        expect(history.map((m) => calibratedGlucose(m, cal))).toEqual(g.histCal);
        expect(history.flatMap((m, i) => (m.error.length > 1 || m.error[0] !== 0 ? [i] : []))).toEqual(g.histErrorIdx);
        expect(fromHistoryMeasurements(history, cal).map((x) => x.glucoseDouble)).toEqual(g.histCal);
    });
    it('flags FRAM decrypted with the wrong UID via CRC', () => {
        const wrong = uid.slice();
        wrong[0] = wrong[0] ^ 0xff;
        const bad = SensorData.create(wrong, decryptFram('Libre 2', wrong, info, fromHex(vector.buffer)), READ_DATE);
        expect(bad.hasValidCRCs).toBe(false);
    });
});
describe('Libre 2 BLE (PreLibre2.swift BLEExample)', () => {
    const uid = fromHex(LIBRE2_BLE_EXAMPLE.sensorId);
    const data = fromHex(LIBRE2_BLE_EXAMPLE.data);
    it('decrypts the 46-byte packet to the Swift result and verifies the CRC', () => {
        expect(hex(decryptBle(uid, data))).toBe('ee098c09e6898b0dd1c98a0dc1898c09a6098d0d9dc98a0d94c98a0dd2c98a0d000008040000080cf52cc08e');
    });
    it('parses age, trend and history like Libre2.parseBLEData', () => {
        const now = READ_DATE;
        const r = parseBleData(decryptBle(uid, data), now);
        expect(r.age).toBe(11509);
        expect(r.crcVerified).toBe(true);
        const ex2Cal = GOLDEN.example2.calibration;
        expect(r.trend.map((m) => [m.rawGlucose, m.rawTemperature, m.rawTemperatureAdjustment, m.idValue, (now - m.date) / 60_000, calibratedGlucose(m, ex2Cal)])).toEqual([
            [2452, 6316, 12, 11494, 6, 202],
            [2461, 6316, 12, 11497, 5, 203],
            [2470, 6352, 12, 11502, 4, 205],
            [2497, 6344, 8, 11503, 3, 207],
            [2513, 6316, 12, 11505, 2, 207],
            [2534, 6328, 12, 11507, 1, 210],
            [2542, 6336, 8, 11509, 0, 211],
        ]);
        expect(r.history.map((m) => [m.rawGlucose, m.idValue, (now - m.date) / 60_000])).toEqual([[2514, 11505, 7]]);
    });
    it('rejects a corrupted packet and a packet for another sensor', () => {
        const corrupted = data.slice();
        corrupted[20] = corrupted[20] ^ 0x01;
        expect(() => decryptBle(uid, corrupted)).toThrow(/decrytion failed/);
        expect(() => decryptBle(fromHex(LIBRE2_EXAMPLE.sensorId), data)).toThrow();
    });
});
describe('Libre 2 NFC / BLE unlock commands', () => {
    const uid = fromHex(LIBRE2_EXAMPLE2.sensorId);
    const info = fromHex(LIBRE2_EXAMPLE2.sensorInfo);
    it('matches the Swift activate, enable-streaming and unlock payloads', () => {
        expect(hex(activateParameters(uid))).toBe('1b7abae645');
        expect(hex(enableStreamingParameters(uid, info))).toBe('1e2a000000ad38d2fa');
        expect(hex(streamingUnlockPayload(uid, info, 42, 1))).toBe('2b0000007fadc346daa38ec6');
        expect(hex(streamingUnlockPayload(uid, info, 42, 7))).toBe('31000000fb92e03c9d17166d');
    });
    it('normalizes CoreNFC (MSB-first) and already reversed UIDs', () => {
        expect(hex(normalizeSensorUid(fromHex('e007a40000be20df')))).toBe('df20be0000a407e0');
        expect(hex(normalizeSensorUid(uid))).toBe(LIBRE2_EXAMPLE2.sensorId);
    });
});
describe('sensor identification', () => {
    it('derives the serial number from the UID (SensorSerialNumber.swift doc example)', () => {
        expect(sensorSerialNumber(fromHex('5e902500 00a007e0'), 0)).toBe('0M00009DHCR');
    });
    it('classifies patch info like SensorType(patchInfo:)', () => {
        expect(sensorTypeFromPatchInfo(fromHex('df0000000000'))).toBe('Libre 1');
        expect(sensorTypeFromPatchInfo(fromHex('e50003000000'))).toBe('Libre US 14d');
        expect(sensorTypeFromPatchInfo(fromHex('9d0830010000'))).toBe('Libre 2');
        expect(sensorTypeFromPatchInfo(fromHex('760002020000'))).toBe('Libre 2 US');
        expect(sensorTypeFromPatchInfo(fromHex('760000040000'))).toBe('Libre 2 CA');
        expect(sensorTypeFromPatchInfo(fromHex('760070000000'))).toBe('Libre Sense');
        expect(sensorTypeFromPatchInfo(new Uint8Array(24))).toBe('Libre 3');
    });
    it('matches Libre 2 advertisements by MAC name, or legacy name plus manufacturer data', () => {
        const uid = fromHex(LIBRE2_EXAMPLE2.sensorId);
        const sensor = { uid, patchInfo: fromHex(LIBRE2_EXAMPLE2.sensorInfo), maxAge: 0, unlockCount: 0, macAddress: 'A4B7C9023F8D', serialNumber: null };
        expect(matchesLibre2Advertisement({ name: 'A4B7C9023F8D', manufacturerData: null }, sensor)).toBe(true);
        const mfr = fromHex('0000df20be0000a4');
        expect(verifyLibre2ManufacturerData(mfr, uid)).toBe(true);
        expect(matchesLibre2Advertisement({ name: 'ABBOTT3MH001GJ0VW', manufacturerData: mfr }, { ...sensor, macAddress: null })).toBe(true);
        expect(matchesLibre2Advertisement({ name: 'ABBOTT3MH001GJ0VW', manufacturerData: fromHex('0000aaaaaaaaaaaa') }, { ...sensor, macAddress: null })).toBe(false);
        expect(canSupportLibre2Peripheral('something', null)).toBe(false);
    });
    it('reads Bubble firmware/hardware/MAC from manufacturer data', () => {
        expect(getBubbleDetailsFromAdvertisement(fromHex('0000aabbccddeeff02060101'))).toEqual({ mac: 'FF:EE:DD:CC:BB:AA', firmware: '2.06', hardware: '1.01' });
        expect(getBubbleDetailsFromAdvertisement(null)).toEqual({ mac: null, firmware: null, hardware: null });
    });
    it('LimitedQueue drops the oldest entries', () => {
        const q = new LimitedQueue(3);
        [1, 2, 3, 4, 5].forEach((n) => q.enqueue(n));
        expect(q.array).toEqual([3, 4, 5]);
    });
});
