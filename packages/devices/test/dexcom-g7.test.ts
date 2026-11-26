/**
 * Dexcom G7 tests. Protocol vectors and manager tests are ported from the G7SensorKitTests of
 * loopandlearn/G7SensorKit (MIT, © 2022 LoopKit Authors); the end-to-end tests drive the
 * driver against the sensor simulator over the in-memory BLE fake.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemorySecretStore, fromHex, silentLogger, type Clock, type DeviceContext } from '@buddy/core';
import {
  AlgorithmState,
  createDexcomG7Source,
  dexcomG7Cgm,
  EMPTY_G7_STATE,
  G7CgmManager,
  G7Sensor,
  G7_STATE_KEY,
  glucoseTimestamp,
  g7Trend,
  normalizeSensorName,
  parseExtendedVersionMessage,
  parseG7BackfillMessage,
  parseG7GlucoseMessage,
  parseG7State,
  serializeG7State,
  type G7State,
} from '../src/dexcom-g7';
import { createG7Simulator, encodeG7Glucose } from '../src/dexcom-g7/simulator';
import { createFakeBle } from '../src/testkit';

const msg = (h: string) => parseG7GlucoseMessage(fromHex(h))!;

describe('Dexcom G7 messages (ported G7GlucoseMessageTests)', () => {
  it('message data', () => {
    const m = msg('4e00c35501002601000106008a00060187000f');
    expect(m.glucose).toBe(138);
    expect(glucoseTimestamp(m)).toBe(87485);
    expect(m.glucoseIsDisplayOnly).toBe(false);
  });

  it('message data with calibration', () => {
    const m = msg('4e000ec10d00c00b00010000680006fe63001f');
    expect(m.glucose).toBe(104);
    expect(glucoseTimestamp(m)).toBe(901390);
    expect(m.glucoseIsDisplayOnly).toBe(true);
  });

  it('lifecycle', () => {
    const ms = [
      '4e00b6000000010000006600ffff017fffff00',
      '4e00cd000000030000010500ffff027fffff01',
      '4e00f90100000400000105009100027effff02',
      '4e00250300000500000105007d00027effff02',
      '4e0051040000060000010500650002dfffff02',
      '4e007d0500000700000105004e0002e7ffff02',
      '4e00ab060000080000010700540006f5ffff0e',
      '4e00d507000009000001050061000601ffff0e',
      '4e004d440e00d40b0001d46b650018036a000e',
    ].map(msg);
    expect(ms[0]!.glucose).toBeNull();
    expect(ms[1]!.glucose).toBeNull();
    expect(ms[2]!.glucose).toBe(145);
    const S = AlgorithmState;
    expect(ms.map((m) => m.algorithmState)).toEqual([S.stopped, S.warmup, S.warmup, S.warmup, S.warmup, S.warmup, S.ok, S.ok, S.expired]);
    expect(ms.map((m) => m.sequence)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 3028]);
    expect(ms.map(glucoseTimestamp)).toEqual([80, 200, 500, 800, 1100, 1400, 1700, 2000, 907385]);
  });

  it('details', () => {
    // readEGV(txTime=40104,seq=136,session=1,age=4,value=141,pred=138,algo=6,subAlgo=15,rate=3)
    const m = msg('4e00a89c00008800000104008d0006038a000f');
    expect([m.glucose, glucoseTimestamp(m), m.sequence, m.age, m.predicted, m.trend, m.algorithmState]).toEqual([141, 40100, 136, 4, 138, 0.3, AlgorithmState.ok]);
    expect(m.glucoseIsDisplayOnly).toBe(false);
  });

  it('negative and missing rate', () => {
    expect(msg('4e00c6cc0d00ca0b00010500610006fe5b000f').trend).toBe(-0.2);
    expect(msg('4e00c6cc0d00ca0b000105006100067f5b000f').trend).toBeNull();
    expect(g7Trend(msg('4e00c6cc0d00ca0b000105006100067f5b000f'))).toBe('unknown');
  });

  it('two-byte age (also on an expired sensor)', () => {
    const a = msg('4e00f9590200030200012a018f000610d9000f');
    expect([a.age, a.messageTimestamp, glucoseTimestamp(a)]).toEqual([298, 154105, 153807]);
    const b = msg('4e004d440e00d40b0001d46b650018036a000e');
    expect([b.age, b.messageTimestamp, glucoseTimestamp(b)]).toEqual([27604, 934989, 907385]);
  });

  it('rejects short messages and a non-zero status byte', () => {
    expect(parseG7GlucoseMessage(fromHex('4e00c35501002601000106008a00060187000f').slice(0, 18))).toBeNull();
    expect(parseG7GlucoseMessage(fromHex('4e01c35501002601000106008a00060187000f'))).toBeNull();
  });

  it('backfill', () => {
    const b = parseG7BackfillMessage(fromHex('cf5802008f00060f10'))!;
    expect([b.timestamp, b.glucose, b.algorithmState, b.glucoseIsDisplayOnly]).toEqual([153807, 143, AlgorithmState.ok, false]);
    expect(parseG7BackfillMessage(fromHex('f20e0d00ba00060ffb'))!.timestamp).toBe(855794);
    expect(parseG7BackfillMessage(fromHex('f63d00008500061efe'))!.glucoseIsDisplayOnly).toBe(true);
    expect(parseG7BackfillMessage(fromHex('cf5802008f00060f'))).toBeNull();
  });

  it('extended version (ExtendedVersionMessageTests)', () => {
    const a = parseExtendedVersionMessage(fromHex('5200c0d70d00540600020404ff0c00'))!;
    expect(a.sessionLength / 3600 / 24).toBe(10.5);
    expect(a.warmupDuration / 60).toBe(27);
    expect([a.algorithmVersion, a.hardwareVersion, a.maxLifetimeDays]).toEqual([67371520, 255, 12]);
    const b = parseExtendedVersionMessage(fromHex('5200406f1400880e00010a04ff1100'))!;
    expect(b.sessionLength / 3600 / 24).toBe(15.5);
    expect(b.warmupDuration / 60).toBe(62);
    expect([b.algorithmVersion, b.hardwareVersion, b.maxLifetimeDays]).toEqual([67764480, 255, 17]);
  });

  it('simulator encoding round-trips through the parser', () => {
    const m = msg(Array.from(encodeG7Glucose({ messageTimestamp: 1000, age: 5, glucose: 111, trend: -1.5, sequence: 7 }), (b) => b.toString(16).padStart(2, '0')).join(''));
    expect([m.glucose, glucoseTimestamp(m), m.trend, m.sequence, m.algorithmState]).toEqual([111, 995, -1.5, 7, AlgorithmState.ok]);
  });
});

// ── manager (ported G7CGMManagerTests) ─────────────────────────────────────────

const SENSOR_ID = 'DXCM99';
const realClock: Clock = { now: () => Date.now() };
const okGlucoseMessage = msg('4e00c35501002601000106008a00060187000f');

function makeManager(state: Partial<G7State>, graceMs?: number, persisted: G7State[] = []) {
  return new G7CgmManager(
    { ...EMPTY_G7_STATE, sensorID: SENSOR_ID, activatedAt: Date.now() - 54_000_000, ...state },
    {
      clock: realClock,
      log: silentLogger,
      persist: (s) => void persisted.push(s),
      onReadings: () => undefined,
      suspectedSessionEndGraceMs: graceMs,
      makeSensor: (delegate, sensorID) => new G7Sensor({ sensorID, ble: createFakeBle().transport, clock: realClock, log: silentLogger, delegate }),
    },
  );
}

describe('Dexcom G7 manager', () => {
  it('restore forgets the sensor when the grace period expired while not running', () => {
    const m = makeManager({ suspectedSessionEndAt: Date.now() - 3_600_000, latestReadingTimestamp: Date.now() - 7_200_000 });
    expect(m.state.sensorID).toBeNull();
    expect(m.sensor.followedSensorID).toBeNull();
    m.dispose();
  });

  it('restore keeps the sensor when a reading arrived after grace start', () => {
    const m = makeManager({ suspectedSessionEndAt: Date.now() - 3_600_000, latestReadingTimestamp: Date.now() - 60_000 });
    expect(m.state.sensorID).toBe(SENSOR_ID);
    expect(m.state.suspectedSessionEndAt).toBeNull();
    m.dispose();
  });

  it('restore keeps the sensor while the grace period is still running', () => {
    const m = makeManager({ suspectedSessionEndAt: Date.now() - 60_000, latestReadingTimestamp: Date.now() - 120_000 });
    expect(m.state.sensorID).toBe(SENSOR_ID);
    expect(m.state.suspectedSessionEndAt).not.toBeNull();
    m.dispose();
  });

  it('restore with no pending grace leaves the sensor alone', () => {
    const m = makeManager({ latestReadingTimestamp: Date.now() - 7_200_000 });
    expect(m.state.sensorID).toBe(SENSOR_ID);
    m.dispose();
  });

  it('suspected session end persists the grace start and keeps the sensor during grace', () => {
    const persisted: G7State[] = [];
    const m = makeManager({}, 10_000, persisted);
    m.sensorDisconnected(true);
    expect(m.state.suspectedSessionEndAt).not.toBeNull();
    expect(persisted.at(-1)?.suspectedSessionEndAt).toBe(m.state.suspectedSessionEndAt);
    expect(m.state.sensorID).toBe(SENSOR_ID);
    m.dispose();
  });

  it('a reading clears the persisted grace start', () => {
    const m = makeManager({}, 10_000);
    m.sensorDisconnected(true);
    m.didRead(okGlucoseMessage);
    expect(m.state.suspectedSessionEndAt).toBeNull();
    m.dispose();
  });

  it('forgets the sensor after the grace period without readings', async () => {
    const m = makeManager({}, 50);
    m.sensorDisconnected(true);
    await vi.waitFor(() => expect(m.state.sensorID).toBeNull(), { timeout: 2000 });
    m.dispose();
  });

  it('a reading during the grace period prevents forgetting the sensor', async () => {
    const m = makeManager({}, 100);
    m.sensorDisconnected(true);
    m.didRead(okGlucoseMessage);
    await new Promise((r) => setTimeout(r, 250));
    expect(m.state.sensorID).toBe(SENSOR_ID);
    m.dispose();
  });

  it('grace expiry after comms since grace start keeps the sensor', () => {
    const m = makeManager({}, 100_000);
    m.sensorDisconnected(true);
    const graceStart = m.state.suspectedSessionEndAt!;
    m.didRead(okGlucoseMessage);
    m.handleSuspectedSessionEndGraceExpiry(graceStart);
    expect(m.state.sensorID).toBe(SENSOR_ID);
    m.dispose();
  });

  it('grace expiry without comms forgets the sensor', () => {
    const m = makeManager({}, 100_000);
    m.sensorDisconnected(true);
    m.handleSuspectedSessionEndGraceExpiry(m.state.suspectedSessionEndAt!);
    expect(m.state.sensorID).toBeNull();
    m.dispose();
  });

  it('a stale grace expiry does not forget the sensor', () => {
    const m = makeManager({}, 100_000);
    m.sensorDisconnected(true);
    m.handleSuspectedSessionEndGraceExpiry(Date.now() - 3_600_000);
    expect(m.state.sensorID).toBe(SENSOR_ID);
    m.dispose();
  });

  it('a non-suspected disconnect does not forget the sensor', async () => {
    const m = makeManager({}, 50);
    m.sensorDisconnected(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(m.state.sensorID).toBe(SENSOR_ID);
    m.dispose();
  });

  it('state round-trips through serialisation', () => {
    const s: G7State = {
      ...EMPTY_G7_STATE,
      sensorID: SENSOR_ID,
      activatedAt: 123,
      extendedVersion: parseExtendedVersionMessage(fromHex('5200c0d70d00540600020404ff0c00')),
      latestReading: okGlucoseMessage,
      suspectedSessionEndAt: 456,
    };
    const r = parseG7State(serializeG7State(s));
    expect(r.sensorID).toBe(SENSOR_ID);
    expect(r.extendedVersion?.maxLifetimeDays).toBe(12);
    expect(r.latestReading?.glucose).toBe(138);
    expect(r.suspectedSessionEndAt).toBe(456);
    expect(parseG7State('not json')).toEqual(EMPTY_G7_STATE);
  });
});

// ── end to end ─────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const fixedClock: Clock = { now: () => NOW };
const ctxWith = (ble: DeviceContext['ble'], secrets = createMemorySecretStore(), log = silentLogger): DeviceContext => ({
  clock: fixedClock,
  log,
  fetch: (() => Promise.reject(new Error('no fetch'))) as unknown as typeof fetch,
  ble,
  secrets,
});
const FAST = { reconnectDelayMs: 5_000, rescanDelayMs: 5_000, responseTimeoutMs: 500, adapterRetryMs: 20 };

describe('Dexcom G7 plugin', () => {
  it('has the expected meta and validates settings / BLE', () => {
    expect(dexcomG7Cgm.meta).toMatchObject({ id: 'dexcom-g7', transport: 'ble', maturity: 'experimental' });
    expect(() => dexcomG7Cgm.create({ sensorName: '' }, ctxWith(undefined))).toThrow(/Bluetooth/);
    expect(() => dexcomG7Cgm.create({ sensorName: 'ABC' }, ctxWith(createFakeBle().transport))).toThrow(/DXCM/);
    expect(normalizeSensorName(' dxcm1a ')).toBe('DXCM1A');
    expect(normalizeSensorName('')).toBeNull();
  });

  it('discovers a new sensor, reads glucose + backfill and persists the sensor', async () => {
    const fake = createFakeBle();
    const messageTimestamp = 200_000;
    const sim = createG7Simulator({
      name: 'DXCM1A',
      glucose: { messageTimestamp, age: 4, glucose: 141, trend: 0.3 },
      backfill: [
        { timestamp: messageTimestamp - 604, glucose: 150, trend: -1 },
        { timestamp: messageTimestamp - 304, glucose: 145, trend: -1 },
      ],
    });
    fake.add(sim);
    const secrets = createMemorySecretStore();
    const src = createDexcomG7Source({ sensorName: '' }, ctxWith(fake.transport, secrets), { timing: FAST });
    await src.start();
    await vi.waitFor(async () => expect((await src.readings(0)).length).toBe(3), { timeout: 2000 });
    await vi.waitFor(() => expect(sim.versionRequests).toBe(1), { timeout: 2000 });
    await src.stop();
    const rs = await src.readings(0);
    const activation = NOW - messageTimestamp * 1000;
    expect(rs).toEqual([
      { date: activation + (messageTimestamp - 604) * 1000, value: 150, trend: 'fortyFiveDown', source: 'dexcom-g7' },
      { date: activation + (messageTimestamp - 304) * 1000, value: 145, trend: 'fortyFiveDown', source: 'dexcom-g7' },
      { date: NOW - 4_000, value: 141, trend: 'flat', source: 'dexcom-g7' },
    ]);
    expect(await src.readings(NOW - 4_000)).toEqual([]);
    const state = parseG7State(await secrets.get(G7_STATE_KEY));
    expect(state.sensorID).toBe('DXCM1A');
    expect(state.activatedAt).toBe(activation);
    expect(state.extendedVersion?.sessionLength).toBe(907_200);
  });

  it('follows only the pinned sensor', async () => {
    const fake = createFakeBle();
    fake.add(createG7Simulator({ name: 'DXCM2B', deviceId: 'other', glucose: { messageTimestamp: 1000, glucose: 99 } }));
    const src = createDexcomG7Source({ sensorName: 'DXCM1A' }, ctxWith(fake.transport), { timing: FAST });
    await src.start();
    await new Promise((r) => setTimeout(r, 80));
    await src.stop();
    expect(await src.readings(0)).toEqual([]);
    expect(fake.writes.length).toBe(0);
  });

  it('drops warm-up readings (unreliable algorithm state)', async () => {
    const fake = createFakeBle();
    fake.add(createG7Simulator({ glucose: { messageTimestamp: 1000, glucose: 145, state: AlgorithmState.warmup } }));
    const src = createDexcomG7Source({ sensorName: 'DXCM1A' }, ctxWith(fake.transport), { timing: FAST });
    await src.start();
    await new Promise((r) => setTimeout(r, 80));
    await src.stop();
    expect(await src.readings(0)).toEqual([]);
  });

  it('flags a suspected session end when the link drops without authentication', async () => {
    const fake = createFakeBle();
    fake.add(createG7Simulator({ authenticates: false, glucose: { messageTimestamp: 1000, glucose: 100 } }));
    const secrets = createMemorySecretStore({ [G7_STATE_KEY]: serializeG7State({ ...EMPTY_G7_STATE, sensorID: 'DXCM1A', activatedAt: NOW - 1_000_000 }) });
    const src = createDexcomG7Source({ sensorName: '' }, ctxWith(fake.transport, secrets), { timing: FAST, suspectedSessionEndGraceMs: 60_000 });
    await src.start();
    await vi.waitFor(async () => expect(parseG7State(await secrets.get(G7_STATE_KEY)).suspectedSessionEndAt).toBe(NOW), { timeout: 2000 });
    await src.stop();
    expect(parseG7State(await secrets.get(G7_STATE_KEY)).sensorID).toBe('DXCM1A');
  });
});
