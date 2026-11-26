/**
 * Syai Ultra session and driver tests against the sensor and cloud simulators over the in-memory
 * BLE fake: handshake, firmware gate, live decode, grid thinning, warmup, backfill, mis-served
 * history, faults, reconnect and persistence. Protocol cases follow SyaiKit (MIT, © 2026
 * Nightscout Foundation).
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemorySecretStore, silentLogger, type DeviceContext, type Logger } from '@buddy/core';
import { CHAR, normalizeSensorMac, SERVICE, SYAI_STATE_KEY, SYAI_ACCOUNT_KEY, syaiCgm, createSyaiSource, SyaiSession, SyaiManager, EMPTY_SYAI_STATE, sensorRecordFrom, type SyaiSettings, type DecryptedFrame } from '../src/syai';
import { createSyaiCloudSim, type SimBoundSensor } from '../src/syai/cloud-simulator';
import { createSyaiSimulator, currentForMgdl, linearCoefficients, type SyaiSimOptions } from '../src/syai/simulator';
import { createFakeBle } from '../src/testkit';

const MAC = 'AABBCCDDEEFF';
const KEY_GROUP = Uint8Array.from({ length: 96 }, (_, i) => (i * 3 + 11) & 0xff);
const ACTIVATED_AT = 1_780_000_000_000;
const settings: SyaiSettings = { email: 'me@example.com', password: 'hunter2-Secret', sensorMac: '' };
const bound: SimBoundSensor = { mac: MAC, keyGroup: KEY_GROUP, coefficients: linearCoefficients(), produceTime: 1_770_000_000_000, coeffUpdateTime: 1_770_346_120_828, activeTime: ACTIVATED_AT };
const FAST = { staleLinkMs: 60_000, droppedRetryMs: 15, noSensorRetryMs: 15, authRetryMs: 15, cloudRetryMs: 15, bluetoothRetryMs: 15, replacementCheckMs: 15 };
/** What the program emits for a target: the sensor's own 0.1 mmol/L step, then whole mg/dL. */
const decoded = (mgdl: number) => Math.round((Math.round((mgdl / 18.01559) * 10) / 10) * 18.01559);
const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await tick(5);
  }
};

function world(sim: Partial<SyaiSimOptions> = {}, opts: { sensor?: SimBoundSensor | null; secrets?: Record<string, string>; now?: () => number } = {}) {
  const ble = createFakeBle();
  const sensor = createSyaiSimulator({ mac: MAC, keyGroup: KEY_GROUP, liveIndex: 200, ...sim });
  ble.add(sensor);
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  const clock = { now: opts.now ?? (() => ACTIVATED_AT + 200 * 60_000 + 5_000) };
  const cloud = createSyaiCloudSim({ clock, email: settings.email, password: settings.password, sensor: opts.sensor === undefined ? bound : opts.sensor });
  const secrets = createMemorySecretStore(opts.secrets);
  const ctx: DeviceContext = { clock, log, fetch: cloud.fetch, ble: ble.transport, secrets };
  return { ble, sensor, cloud, ctx, secrets, lines, clock };
}

const start = async (w: ReturnType<typeof world>, s: SyaiSettings = settings, timing: Partial<typeof FAST> = {}) => {
  const source = createSyaiSource(s, w.ctx, { timing: { ...FAST, ...timing }, sessionTimeouts: { scanMs: 200, connectMs: 200 } });
  await source.start();
  return source;
};

describe('session against the simulator', () => {
  const env = (w: ReturnType<typeof world>) => ({ ble: w.ble.transport, clock: w.clock, log: w.ctx.log, random: (n: number) => crypto.getRandomValues(new Uint8Array(n)) });
  const target = { mac: MAC, keyGroup: KEY_GROUP, peripheralId: null };

  it('scans by advertised MAC, authenticates, gates firmware, reads cmd state and streams the connect burst', async () => {
    const w = world();
    const frames: DecryptedFrame[] = [];
    const s = await SyaiSession.connect(env(w), target, { onFrame: (f) => frames.push(f), onBatch: () => {} });
    expect(w.sensor.authenticated).toBe(true);
    expect(s.firmwareVersion).toBe('E2.0.1(V1.7.SH22537.1)');
    expect(s.parseVersion).toBe('V1.7');
    expect(s.reportedCmdState).toBe(3);
    expect(w.ble.writes.find((x) => x.characteristic === CHAR.ctlDevice)?.data).toEqual(new Uint8Array([0x08, 25, 26, 4, 6]));
    await tick();
    expect(frames).toHaveLength(1);
    expect([frames[0]!.sequence, frames[0]!.isHistorical, frames[0]!.parseVersion]).toEqual([200, false, 'V1.7']);
    await s.disconnect();
  });

  it('uses the stored peripheral id before scanning', async () => {
    const w = world();
    const s = await SyaiSession.connect(env(w), { ...target, peripheralId: w.sensor.id }, { onFrame: () => {}, onBatch: () => {} });
    expect(s.peripheralId).toBe(w.sensor.id);
    await s.disconnect();
  });

  it('fails with noSensorFound when the MAC is not advertised', async () => {
    const w = world();
    await expect(SyaiSession.connect(env(w), { ...target, mac: '112233445566' }, { onFrame: () => {}, onBatch: () => {} }, { scanMs: 20, connectMs: 20 })).rejects.toMatchObject({ kind: 'noSensorFound' });
  });

  it('refuses a sensor whose key group does not match, before writing anything', async () => {
    const w = world();
    await expect(SyaiSession.connect(env(w), { ...target, keyGroup: new Uint8Array(96).fill(1) }, { onFrame: () => {}, onBatch: () => {} })).rejects.toMatchObject({ kind: 'authFailed' });
    expect(w.ble.writes).toHaveLength(0);
  });

  it('refuses unverified firmware without touching the sensor beyond the handshake', async () => {
    const w = world({ firmware: 'E2.2.0(V1.9.SH30101.1)' });
    await expect(SyaiSession.connect(env(w), target, { onFrame: () => {}, onBatch: () => {} })).rejects.toMatchObject({ kind: 'unsupportedFirmware' });
    expect(w.ble.writes.map((x) => x.characteristic)).not.toContain(CHAR.ctlDevice);
    expect(w.ble.writes.map((x) => x.characteristic)).not.toContain(CHAR.requestByCount);
  });

  it('finds each characteristic under its service even when the first guess is wrong', async () => {
    const strict = { [CHAR.cmd]: SERVICE.ctl, [CHAR.softVersion]: SERVICE.auth, [CHAR.newGlucose]: SERVICE.auth, [CHAR.currentTime]: SERVICE.deviceInfo };
    const w = world({ strictServices: strict });
    const frames: DecryptedFrame[] = [];
    const s = await SyaiSession.connect(env(w), target, { onFrame: (f) => frames.push(f), onBatch: () => {} });
    expect(s.reportedCmdState).toBe(3);
    await tick();
    expect(frames).toHaveLength(1);
    await s.disconnect();
  });

  it('a V1.6 sensor streams 8-byte records', async () => {
    const w = world({ firmware: 'E1.9.0(V1.6.SH22001.1)' });
    const frames: DecryptedFrame[] = [];
    const s = await SyaiSession.connect(env(w), target, { onFrame: (f) => frames.push(f), onBatch: () => {} });
    await tick();
    expect(s.parseVersion).toBe('V1.6');
    expect(frames[0]!.plaintext).toHaveLength(12);
    await s.disconnect();
  });
});

describe('syai driver', () => {
  it('declares the plugin and settings schema', () => {
    expect(syaiCgm.meta).toMatchObject({ id: 'syai-ultra', name: 'Syai Ultra', manufacturer: 'Syai', transport: 'ble', maturity: 'experimental' });
    const fields = syaiCgm.settings.flatMap((s) => s.fields);
    expect(fields.map((f) => f.key)).toEqual(['email', 'password', 'sensorMac']);
    expect(fields.find((f) => f.key === 'password')).toMatchObject({ kind: 'text', secret: true });
    expect(Object.keys(syaiCgm.defaultSettings).sort()).toEqual(['email', 'password', 'sensorMac']);
    expect(normalizeSensorMac(' aa:bb:cc:dd:ee:ff ')).toBe(MAC);
    expect(normalizeSensorMac('')).toBeNull();
    expect(() => normalizeSensorMac('nonsense')).toThrow(/12 hex digits/);
  });

  it('needs a BLE transport', () => {
    expect(() => createSyaiSource(settings, { clock: { now: Date.now }, log: silentLogger, fetch: globalThis.fetch })).toThrow(/Bluetooth/);
  });

  it('end to end: account lookup, handshake, live reading dated by sensor time, nothing secret persisted in the clear', async () => {
    const w = world({ liveIndex: 200 });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    const rs = await (async () => {
      await until(() => true);
      await tick(60);
      return source.readings(0);
    })();
    expect(rs).toEqual([{ date: ACTIVATED_AT + (60 * 200 + 62) * 1000, value: 110, trend: 'unknown', source: 'syai-ultra' }]);
    expect(source.status()).toMatchObject({ mac: MAC, connected: true, fault: null, lifecycle: { phase: 'active' } });
    expect(w.cloud.logins.count).toBe(1);
    await source.stop();
    expect(w.lines.join('\n')).not.toContain('hunter2-Secret');
    const state = JSON.parse((await w.secrets.get(SYAI_STATE_KEY))!);
    expect(state.sensor.deviceInfo.mac).toBe(MAC);
    expect(state.lastGridSequence).toBe(200);
    expect(await w.secrets.get(SYAI_ACCOUNT_KEY)).not.toContain('hunter2-Secret');
  });

  it('only every 5th record is forwarded, and live trend comes from consecutive live records', async () => {
    // 6.1 mmol/L (110 mg/dL) up to record 104, then 6.2 (112 mg/dL): +2 mg/dL in the minute before record 105.
    const w = world({ liveIndex: 100, record: (i) => ({ current: i >= 105 ? 6200 : 6100 }) });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(40);
    for (let i = 101; i <= 106; i++) {
      w.sensor.pushLive(i);
      await tick(10);
    }
    const rs = await source.readings(0);
    expect(rs.map((r) => r.value)).toEqual([110, 112]); // records 100 and 105 only
    expect(rs.map((r) => r.trend)).toEqual(['unknown', 'singleUp']);
    expect(w.sensor.historyRequests).toHaveLength(0);
    await source.stop();
  });

  it('a reading dated in the future (server or phone clock off) is not forwarded', async () => {
    const w = world({ liveIndex: 200 }, { now: () => ACTIVATED_AT + 195 * 60_000 }); // reading lies ~5 min ahead
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(60);
    expect(await source.readings(0)).toEqual([]);
    expect(w.lines.join('\n')).toMatch(/in the future/);
    await source.stop();
  });

  it('records inside warmup are not forwarded', async () => {
    const w = world({ liveIndex: 10 });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(60);
    expect(await source.readings(0)).toEqual([]);
    expect(source.status().lifecycle.phase).toBe('warmup');
    await source.stop();
  });

  it('backfills a gap on the 5-minute grid and the dedupe makes live + backfill one series', async () => {
    const w = world({ liveIndex: 1000, record: (i) => ({ current: currentForMgdl(100 + (i % 50)) }) }, { now: () => ACTIVATED_AT + 1030 * 60_000 });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(40);
    w.sensor.pushLive(1021); // 1001...1020 were missed
    await until(() => w.sensor.historyRequests.length === 1);
    await tick(60);
    expect(w.sensor.historyRequests).toEqual([{ from: 1005, count: 16 }]); // 1005..1020, newest 1021 excluded
    const rs = await source.readings(0);
    expect(rs.map((r) => r.date)).toEqual([1000, 1005, 1010, 1015, 1020].map((i) => ACTIVATED_AT + (60 * i + 62) * 1000));
    expect(rs.map((r) => r.value)).toEqual([1000, 1005, 1010, 1015, 1020].map((i) => decoded(100 + (i % 50))));
    await source.stop();
  });

  it('drops backfilled records whose own clock disagrees with their label (mis-serving firmware)', async () => {
    const w = world({ liveIndex: 1000, replayHistory: true, record: (i) => ({ current: currentForMgdl(100 + (i % 50)) }) }, { now: () => ACTIVATED_AT + 1030 * 60_000 });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(40);
    w.sensor.pushLive(1011);
    await until(() => w.sensor.historyRequests.length === 1);
    await tick(40);
    w.sensor.pushLive(1031); // second request: the sensor replays the previous bodies under new headers
    await until(() => w.sensor.historyRequests.length === 2);
    await tick(60);
    const dates = (await source.readings(0)).map((r) => r.date);
    // 1005, 1010 from the honest first answer; nothing from the replayed one.
    expect(dates).toEqual([1000, 1005, 1010].map((i) => ACTIVATED_AT + (60 * i + 62) * 1000));
    expect(w.lines.some((l) => l.includes('dropping backfilled'))).toBe(true);
    await source.stop();
  });

  it('a dead cmd state latches a terminal fault: no readings, lifecycle failed, persisted', async () => {
    const w = world({ cmdState: 4 });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(60);
    expect(await source.readings(0)).toEqual([]);
    expect(source.status()).toMatchObject({ fault: { kind: 'deviceStateObsolete', state: 4 }, lifecycle: { phase: 'failed' } });
    await source.stop();
    expect(JSON.parse((await w.secrets.get(SYAI_STATE_KEY))!).fault).toEqual({ kind: 'deviceStateObsolete', state: 4 });
  });

  it('a sensor reporting itself unactivated while the account says it started is not trusted', async () => {
    const w = world({ cmdState: 2 });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(60);
    expect(await source.readings(0)).toEqual([]);
    expect(source.status().lifecycle.phase).toBe('unactivated');
    await source.stop();
  });

  it('implausible data suppresses forwarding, then declares the sensor failed', async () => {
    const w = world({ liveIndex: 100, record: () => ({ current: 47 }) });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(40);
    for (let i = 101; i <= 140; i++) {
      w.sensor.pushLive(i);
      await tick(4);
    }
    await tick(40);
    expect(await source.readings(0)).toEqual([]);
    expect(source.status()).toMatchObject({ fault: { kind: 'signalImplausible' }, lifecycle: { phase: 'failed' } });
    await source.stop();
  });

  it('LO/HI clamped values are not measurements and are not forwarded', async () => {
    const w = world({ liveIndex: 100, record: () => ({ current: 100_000 }) }); // 100 mmol/L -> HI (450)
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(60);
    expect(await source.readings(0)).toEqual([]);
    await source.stop();
  });

  it('reconnects after the link drops, authenticating again, and keeps delivering', async () => {
    const w = world({ liveIndex: 200 }, { now: () => ACTIVATED_AT + 210 * 60_000 });
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(40);
    expect(w.sensor.authAttempts).toBe(1);
    w.sensor.drop();
    await until(() => w.sensor.authAttempts === 2 && w.sensor.authenticated);
    await tick(40);
    w.sensor.pushLive(205);
    await tick(40);
    expect((await source.readings(0)).map((r) => r.date)).toEqual([200, 205].map((i) => ACTIVATED_AT + (60 * i + 62) * 1000));
    expect(source.status().connected).toBe(true);
    await source.stop();
  });

  it('a silent link is torn down and reconnected by the stale watchdog', async () => {
    const w = world({}, { now: () => Date.now(), sensor: { ...bound, activeTime: Date.now() - 200 * 60_000 } });
    const source = await start(w, settings, { staleLinkMs: 80 });
    await until(() => w.sensor.authAttempts >= 2, 4000);
    await source.stop();
  });

  it('without account credentials it explains what is missing and does not throw', async () => {
    const w = world();
    const source = await start(w, { email: '', password: '', sensorMac: '' });
    await until(() => source.status().message !== null);
    expect(source.status().message).toMatch(/email and password/);
    expect(w.sensor.authenticated).toBe(false);
    await source.stop();
  });

  it('a pinned MAC that is not the account sensor is refused', async () => {
    const w = world();
    const source = await start(w, { ...settings, sensorMac: '112233445566' });
    await until(() => source.status().message !== null);
    expect(source.status().message).toMatch(/not the pinned 112233445566/);
    expect(w.sensor.authenticated).toBe(false);
    await source.stop();
  });

  it('an account without a bound sensor says so', async () => {
    const w = world({}, { sensor: null });
    const source = await start(w);
    await until(() => source.status().message !== null);
    expect(source.status().message).toMatch(/No sensor is bound/);
    await source.stop();
  });

  it('restarts offline from the persisted sensor record', async () => {
    const w = world();
    const first = await start(w);
    await until(() => w.sensor.authenticated);
    await tick(40);
    await first.stop();
    const offline = createSyaiSource(settings, { ...w.ctx, fetch: vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch }, { timing: FAST, sessionTimeouts: { scanMs: 200, connectMs: 200 } });
    await offline.start();
    await until(() => w.sensor.authAttempts >= 2);
    await offline.stop();
  });

  it('a sensor on unsupported firmware is never retried', async () => {
    const w = world({ firmware: 'E2.2.0(V1.9.SH30101.1)' });
    const source = await start(w);
    await until(() => source.status().message !== null);
    await tick(100);
    expect(w.sensor.authAttempts).toBe(1);
    expect(source.status().message).toMatch(/firmware/);
    await source.stop();
  });

  it('stop() ends the loop and is safe to repeat', async () => {
    const w = world();
    const source = await start(w);
    await until(() => w.sensor.authenticated);
    await source.stop();
    await source.stop();
    expect(source.status().connected).toBe(false);
  });
});

describe('manager', () => {
  const record = sensorRecordFrom({ deviceInfo: { mac: MAC, serialNo: '', batchNo: '', deviceType: '', deviceVersion: '', coefficients: linearCoefficients(), activeDurationSec: 14 * 86400, preheatDurationSec: 1800 }, keyGroup: KEY_GROUP, activatedAt: ACTIVATED_AT });

  it('adopting a different sensor starts clean; the same sensor only refreshes the record', () => {
    const persisted: unknown[] = [];
    const m = new SyaiManager({ ...EMPTY_SYAI_STATE, lastGridSequence: 500, fault: { kind: 'signalImplausible' } }, { clock: { now: Date.now }, log: silentLogger, persist: (s) => persisted.push(s), onReading: () => {}, requestBackfill: async () => {} });
    m.adoptSensor(record);
    expect(m.state).toMatchObject({ lastGridSequence: null, fault: null });
    m.markFault({ kind: 'signalImplausible' });
    m.adoptSensor({ ...record, peripheralId: 'p' });
    expect(m.state.fault).not.toBeNull(); // same MAC: the fault is not forgiven
    m.adoptSensor({ ...record, deviceInfo: { ...record.deviceInfo, mac: '112233445566' } });
    expect(m.state.fault).toBeNull();
    expect(persisted.length).toBeGreaterThan(0);
  });
});
