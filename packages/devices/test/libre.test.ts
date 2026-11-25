/**
 * End-to-end tests for the Libre CGM plugins (TypeScript port of loopandlearn/LibreTransmitter,
 * MIT, (c) the LibreTransmitter authors): fake NFC pairing, fake BLE peripherals that behave like
 * a Libre 2 sensor, a MiaoMiao and a Bubble, and `readings()` checked against values computed by
 * the original Swift code (see libre-protocol.test.ts for how they were produced).
 */
import {
  concatBytes, createMemorySecretStore, fromHex, hex, silentLogger,
  type Bytes, type DeviceContext, type NfcIso15693Tag, type NfcTransport,
} from '@buddy/core';
import { describe, expect, it } from 'vitest';
import { libre2DirectCgm, libreTransmitterCgm, LIBRE_SECRET_KEYS, pairSensor, PairingError, type LibreCgmSource } from '../src/libre';
import { LIBRE2_EXAMPLE, LIBRE2_EXAMPLE2 } from '../src/libre/examples';
import { xorBlePayload } from '../src/libre/libre2-crypto';
import { LIBRE2_NOTIFY, LIBRE2_SERVICE, LIBRE2_WRITE } from '../src/libre/libre2-direct';
import { NORDIC_UART_NOTIFY, NORDIC_UART_SERVICE, NORDIC_UART_WRITE } from '../src/libre/transmitters';
import { createFakeBle, type PeripheralLink } from '../src/testkit';

const T0 = 1_700_000_040_000;

function makeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function makeCtx(over: Partial<DeviceContext> = {}): DeviceContext {
  return { clock: makeClock(), log: silentLogger, fetch: globalThis.fetch, ...over };
}

async function flush(src: LibreCgmSource): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await src.idle();
  }
}

const chunks = (b: Bytes, size: number): Bytes[] => Array.from({ length: Math.ceil(b.length / size) }, (_, i) => b.subarray(i * size, (i + 1) * size));

// ── fake NFC ────────────────────────────────────────────────────────────────

const SENSOR_MAC_RESPONSE = fromHex('8d3f02c9b7a4'); // reversed -> "A4B7C9023F8D"

function fakeLibre2Nfc(vector: { sensorId: string; sensorInfo: string; buffer: string }) {
  const commands: { code: number; params: string }[] = [];
  const fram = fromHex(vector.buffer);
  const tag: NfcIso15693Tag = {
    uid: fromHex(vector.sensorId).reverse(), // CoreNFC identifier order (E0 07 ...)
    transceive: async () => {
      throw new Error('not used');
    },
    async customCommand(code, params) {
      commands.push({ code, params: hex(params) });
      if (code !== 0xa1) throw new Error('unsupported command');
      if (params.length === 0) return fromHex(vector.sensorInfo);
      if (params[0] === 0x1e) return SENSOR_MAC_RESPONSE;
      throw new Error('unexpected sub-command');
    },
    readSingleBlock: async (block) => fram.slice(block * 8, block * 8 + 8),
  };
  const nfc: NfcTransport = {
    isSupported: async () => true,
    withIso15693Tag: (_alert, session) => session(tag),
  };
  return { nfc, commands };
}

// ── Libre 2 BLE plaintext builder (mirrors the e2e vectors generated with the Swift code) ──

/** Encrypts a 44-byte plaintext the way the sensor does (the cipher is a xor stream). */
function encryptLibre2Packet(uid: Bytes, plain: Bytes, prefix = [0x5a, 0x13]): Bytes {
  const cipher = xorBlePayload(uid, concatBytes(new Uint8Array(prefix), plain));
  return concatBytes(new Uint8Array(prefix), cipher);
}

// Plaintexts built and parsed by the Swift harness; with Example2's calibration Swift's
// libreSensorDidUpdate yields 128.2 mg/dL (rounded 128, arrow .up) and 140.2 (140, .up).
const E2E1 = fromHex('dc85b529d285b529c885b529be85b529b985b529a085b5298c85b5297885b5296485b5295085b529b80b91d0');
const E2E2 = fromHex('4086b5a93686b5a92c86b5a92286b5a91d86b5a90486b5a9f085b5a9dc85b5a9c885b5a9b485b5a9bd0bbf10');

describe('libre plugins: construction', () => {
  it('create() throws clearly without BLE or secrets', () => {
    expect(() => libre2DirectCgm.create({}, makeCtx({ secrets: createMemorySecretStore() }))).toThrow(/ctx\.ble/);
    expect(() => libre2DirectCgm.create({}, makeCtx({ ble: createFakeBle().transport }))).toThrow(/ctx\.secrets/);
    expect(() => libreTransmitterCgm.create({ backfillFromHistory: true }, makeCtx({ secrets: createMemorySecretStore() }))).toThrow(/ctx\.ble/);
    expect(libre2DirectCgm.meta).toMatchObject({ id: 'libre-2-direct', transport: 'ble', maturity: 'experimental' });
    expect(libreTransmitterCgm.meta).toMatchObject({ id: 'libre-transmitter', transport: 'ble', maturity: 'experimental' });
  });

  it('pairSensor() requires NFC and rejects non-Libre-2 sensors', async () => {
    await expect(pairSensor({ secrets: createMemorySecretStore(), log: silentLogger })).rejects.toThrow(/ctx\.nfc/);
    const { nfc } = fakeLibre2Nfc({ ...LIBRE2_EXAMPLE2, sensorInfo: 'df0000000000' });
    await expect(pairSensor({ nfc, secrets: createMemorySecretStore(), log: silentLogger })).rejects.toBeInstanceOf(PairingError);
  });

  it('start() fails when no sensor was paired', async () => {
    const src = libre2DirectCgm.create({}, makeCtx({ ble: createFakeBle().transport, secrets: createMemorySecretStore() }));
    await expect(src.start()).rejects.toThrow(/No Libre 2 sensor paired/);
  });
});

describe('libre-2-direct end to end', () => {
  it('pairs via NFC, unlocks over BLE and returns decoded, throttled readings', async () => {
    const secrets = createMemorySecretStore();
    const { nfc, commands } = fakeLibre2Nfc(LIBRE2_EXAMPLE2);
    const info = await pairSensor({ nfc, secrets, log: silentLogger });

    expect(info).toMatchObject({ serialNumber: '3MH001GJ0VW', macAddress: 'A4B7C9023F8D', streamingEnabled: true, sensorType: 'Libre 2', maxMinutesWearTime: 20759 });
    expect(commands.map((c) => c.params)).toEqual(['', '1e2a000000ad38d2fa']);
    expect(JSON.parse((await secrets.get(LIBRE_SECRET_KEYS.libre2Sensor))!)).toMatchObject({ uid: LIBRE2_EXAMPLE2.sensorId, patchInfo: LIBRE2_EXAMPLE2.sensorInfo, unlockCount: 0 });
    expect(JSON.parse((await secrets.get(LIBRE_SECRET_KEYS.libre2CalibrationMapping))!)).toEqual({ uuidHex: LIBRE2_EXAMPLE2.sensorId, reverseFooterCRC: 50801 });

    const uid = fromHex(LIBRE2_EXAMPLE2.sensorId);
    const ble = createFakeBle();
    const unlocks: string[] = [];
    let link: PeripheralLink | null = null;
    const send = (plain: Bytes, prefix?: number[]) => {
      for (const c of chunks(encryptLibre2Packet(uid, plain, prefix), 20)) link!.notify(LIBRE2_SERVICE, LIBRE2_NOTIFY, c);
    };
    ble.add({ id: 'decoy', name: 'ABBOTT0000000', serviceUuids: [LIBRE2_SERVICE], manufacturerData: fromHex('000011223344aabb'), onWrite: () => {} });
    ble.add({
      id: 'libre2-sensor',
      name: 'A4B7C9023F8D',
      serviceUuids: [LIBRE2_SERVICE],
      onConnect: (l) => void (link = l),
      onWrite(_s, c, data) {
        expect(c).toBe(LIBRE2_WRITE);
        unlocks.push(hex(data));
      },
    });

    const clock = makeClock();
    const src = libre2DirectCgm.create({}, makeCtx({ ble: ble.transport, secrets, clock })) as LibreCgmSource;
    await src.start();
    expect(unlocks).toEqual(['2b0000007fadc346daa38ec6']); // streamingUnlockPayload(enableTime 42, unlockCount 1)
    expect(await secrets.get(LIBRE_SECRET_KEYS.libre2DeviceId)).toBe('libre2-sensor');

    send(E2E1);
    await flush(src);
    expect(await src.readings(0)).toEqual([{ date: T0, value: 128, trend: 'fortyFiveUp', source: 'libre-2-direct' }]);

    // one minute later: throttled like Swift (one reading per 4.5 minutes)
    clock.advance(60_000);
    send(E2E2, [0x01, 0x02]);
    await flush(src);
    expect(await src.readings(0)).toHaveLength(1);

    // a corrupted packet is dropped
    clock.advance(4 * 60_000);
    const bad = encryptLibre2Packet(uid, E2E2);
    bad[30] = bad[30]! ^ 0xff;
    for (const c of chunks(bad, 20)) link!.notify(LIBRE2_SERVICE, LIBRE2_NOTIFY, c);
    await flush(src);
    expect(await src.readings(0)).toHaveLength(1);

    clock.advance(60_000);
    send(E2E2, [0x77, 0x01]);
    await flush(src);
    expect(await src.readings(T0)).toEqual([{ date: T0 + 6 * 60_000, value: 140, trend: 'fortyFiveUp', source: 'libre-2-direct' }]);

    // reconnect after a link loss sends a fresh unlock with the next counter
    link!.disconnect(new Error('gone'));
    await new Promise((r) => setTimeout(r, 20));
    expect(unlocks).toEqual(['2b0000007fadc346daa38ec6', expect.stringMatching(/^2c000000/)]);
    await src.stop();
  });
});

// ── MiaoMiao / Bubble ───────────────────────────────────────────────────────

/** MiaoMiao 0x28 packet: header, uid, battery, fw, hw, FRAM, 0x29, optional patch info. */
function miaomiaoPacket(uid: Bytes, fram: Bytes, patchInfo: Bytes | null): Bytes {
  const header = concatBytes(new Uint8Array([0x28, 0x07, 0xb3, 0x54, 0x57]), uid, new Uint8Array([0x64, 0x00, 0x34, 0x00, 0x01]));
  return concatBytes(header, fram, new Uint8Array([0x29]), patchInfo ?? new Uint8Array(0));
}

const EX1_HISTORY = [107, 111, 97, 105, 114, 135, 151, 162, 171, 185, 181, 191, 188, 190, 180, 150, 131, 112, 105, 111, 123, 131, 153, 165, 180, 206, 180, 154, 141, 141, 136, 133];
const EX1_HIST0_DATE = 1_699_999_140_000;
const EX2_HISTORY = [94, 100, 102, 105, 104, 93, 97, 112, 133, 137, 134, 128, 116, 112, 112, 100, 131, 149, 146, 138, 127, 89, 85, 78, 80, 83, 76, 80, 93, 80, 68, 76];
const EX2_HIST_ERRORS = new Set([11, 12, 21, 22, 23, 31]);
const EX2_HIST0_DATE = 1_699_999_740_000;

describe('libre-transmitter end to end', () => {
  it('MiaoMiao with an encrypted Libre 2 FRAM: history backfill plus newest trend value', async () => {
    const ble = createFakeBle();
    const writes: string[] = [];
    const uid = fromHex(LIBRE2_EXAMPLE.sensorId);
    ble.add({
      id: 'mm-1',
      name: 'miaomiao2',
      serviceUuids: [NORDIC_UART_SERVICE],
      onWrite(_s, c, data, link) {
        expect(c).toBe(NORDIC_UART_WRITE);
        writes.push(hex(data));
        if (data[0] === 0xf0) {
          const packet = miaomiaoPacket(uid, fromHex(LIBRE2_EXAMPLE.buffer), fromHex(LIBRE2_EXAMPLE.sensorInfo));
          for (const c2 of chunks(packet, 20)) link.notify(NORDIC_UART_SERVICE, NORDIC_UART_NOTIFY, c2);
        }
      },
    });
    const secrets = createMemorySecretStore();
    const src = libreTransmitterCgm.create({ backfillFromHistory: true }, makeCtx({ ble: ble.transport, secrets })) as LibreCgmSource;
    await src.start();
    await flush(src);

    expect(writes).toEqual(['d301', 'f0']);
    const readings = await src.readings(0);
    const expected = [
      ...EX1_HISTORY.map((value, i) => ({ date: EX1_HIST0_DATE - i * 900_000, value, source: 'libre-transmitter' })),
      { date: T0, value: 100, trend: 'flat', source: 'libre-transmitter' }, // round(99.6), Swift arrow .flat
    ].sort((a, b) => a.date - b.date);
    expect(readings).toEqual(expected);
    expect(JSON.parse((await secrets.get(LIBRE_SECRET_KEYS.transmitterCalibration))!)).toMatchObject({ i2: 858, isValidForFooterWithReverseCRCs: 32654 });
    await src.stop();
  });

  it('Bubble: info, serial, patch info and data packets; error-flagged history is dropped', async () => {
    const ble = createFakeBle();
    const writes: string[] = [];
    const uid = fromHex(LIBRE2_EXAMPLE2.sensorId);
    const fram = fromHex(LIBRE2_EXAMPLE2.buffer);
    ble.add({
      id: 'bubble-1',
      name: 'Bubble_Nano',
      serviceUuids: [NORDIC_UART_SERVICE],
      manufacturerData: fromHex('0000aabbccddeeff02060101'),
      onWrite(_s, _c, data, link) {
        writes.push(hex(data));
        const n = (b: Bytes) => link.notify(NORDIC_UART_SERVICE, NORDIC_UART_NOTIFY, b);
        if (hex(data) === '000005') n(fromHex('8000020650010000')); // bubble info, battery 0x50
        if (hex(data) === '02000000002b') {
          n(concatBytes(fromHex('c000'), uid));
          n(concatBytes(fromHex('c100000000'), fromHex(LIBRE2_EXAMPLE2.sensorInfo)));
          for (const c of chunks(fram, 88)) n(concatBytes(fromHex('82000000'), c));
        }
      },
    });
    const src = libreTransmitterCgm.create({ backfillFromHistory: true }, makeCtx({ ble: ble.transport, secrets: createMemorySecretStore() })) as LibreCgmSource;
    await src.start();
    await flush(src);

    expect(writes).toEqual(['000005', '02000000002b']);
    const expected = [
      ...EX2_HISTORY.flatMap((value, i) => (EX2_HIST_ERRORS.has(i) ? [] : [{ date: EX2_HIST0_DATE - i * 900_000, value, source: 'libre-transmitter' }])),
      { date: T0, value: 94, trend: 'flat', source: 'libre-transmitter' }, // round(93.8)
    ].sort((a, b) => a.date - b.date);
    expect(await src.readings(0)).toEqual(expected);
    expect(await src.readings(T0 - 1)).toHaveLength(1);
    await src.stop();
  });

  it('accepts a plain Libre 1 FRAM without patch info and rejects an encrypted one', async () => {
    const decrypted = fromHex(
      // Example1 decrypted (a valid Libre-1-layout FRAM)
      '24fad01a030000000000000000000000000000000000000013ba0f0f7b0500b05980750500a05980690500945980610500b459805e0500b05980580500bc59804c0508f259804d0500c85980480500b01980410508a259803805009859802e05009859802a0500585980250500745980220500985980880500b85980a60800e85980f108005c5a804109003c59807c0900ec5880bb0800dc5980ac08009c5a802a0800345a80db0700ec59805a0700105a808f0600485a80a70500585a807f0500245980fc0400f859809e0500c059807e0500b05980aa0600a05980e406004059801707004c59800f07007859809907009c5980f908000c5980b10900405a80b30800cc5980f00700205a804b0700945a808f0600905980f905009c5a808a0500445a804705002c5a809a0500085a809506007459807f0700545980502801008e7f3001b609ef50140396805a00cda60e741a000024996c',
    );
    const run = async (fram: Bytes) => {
      const ble = createFakeBle();
      ble.add({
        id: 'mm',
        name: 'miaomiao',
        serviceUuids: [NORDIC_UART_SERVICE],
        onWrite(_s, _c, data, link) {
          if (data[0] === 0xf0) for (const c of chunks(miaomiaoPacket(fromHex(LIBRE2_EXAMPLE.sensorId), fram, null), 20)) link.notify(NORDIC_UART_SERVICE, NORDIC_UART_NOTIFY, c);
        },
      });
      const src = libreTransmitterCgm.create({ backfillFromHistory: false }, makeCtx({ ble: ble.transport, secrets: createMemorySecretStore() })) as LibreCgmSource;
      await src.start();
      await flush(src);
      const r = await src.readings(0);
      await src.stop();
      return r;
    };
    expect(await run(decrypted)).toEqual([{ date: T0, value: 100, trend: 'flat', source: 'libre-transmitter' }]);
    expect(await run(fromHex(LIBRE2_EXAMPLE.buffer))).toEqual([]);
  });

  it('confirms a new sensor (0x32) and ignores packets with a bad CRC', async () => {
    const ble = createFakeBle();
    const writes: string[] = [];
    ble.add({
      id: 'mm',
      name: 'miaomiao',
      serviceUuids: [NORDIC_UART_SERVICE],
      onWrite(_s, _c, data, link) {
        writes.push(hex(data));
        if (data[0] === 0xf0) {
          link.notify(NORDIC_UART_SERVICE, NORDIC_UART_NOTIFY, new Uint8Array([0x32]));
          const fram = fromHex(LIBRE2_EXAMPLE.buffer);
          fram[100] = fram[100]! ^ 0xff;
          for (const c of chunks(miaomiaoPacket(fromHex(LIBRE2_EXAMPLE.sensorId), fram, fromHex(LIBRE2_EXAMPLE.sensorInfo)), 20)) link.notify(NORDIC_UART_SERVICE, NORDIC_UART_NOTIFY, c);
        }
      },
    });
    const src = libreTransmitterCgm.create({ backfillFromHistory: true }, makeCtx({ ble: ble.transport, secrets: createMemorySecretStore() })) as LibreCgmSource;
    await src.start();
    await flush(src);
    expect(writes).toEqual(['d301', 'f0', 'd301']);
    expect(await src.readings(0)).toEqual([]);
    await src.stop();
  });
});
