/**
 * Background operation of the BLE CGM drivers. A backgrounded iOS app is suspended and its JS timers stop, so after a
 * link ends every driver must have a system-managed operation armed (a service-filtered scan without timeout, or a
 * pending connect without timeout) before any timer could fire. The tests freeze the timers right before the link
 * drops: if anything still needed a timer between the disconnect and the next armed operation, it would not be armed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemorySecretStore, silentLogger, type BleAdvertisement, type BleTransport, type DeviceContext } from '@buddy/core';
import { createDexcomG6Source } from '../src/dexcom-g6';
import { ADVERTISEMENT_SERVICE } from '../src/dexcom-g6/ble-common';
import { createG6Simulator } from '../src/dexcom-g6/simulator';
import { createDexcomG7Source } from '../src/dexcom-g7';
import { createG7Simulator } from '../src/dexcom-g7/simulator';
import { LibreBleSession, type SessionProtocol } from '../src/libre/session';
import { createSyaiSource, type SyaiSettings } from '../src/syai';
import { createSyaiCloudSim } from '../src/syai/cloud-simulator';
import { createSyaiSimulator, linearCoefficients } from '../src/syai/simulator';
import { createFakeBle } from '../src/testkit';
import { HeartbeatTransmitter, scanNearbyDevices } from '../src/heartbeat-transmitter';
import { NotBefore, scanFirst } from '../src/ble-rearm';
import { rig, waitFor } from './libre3-helpers';

/** A clock the test moves by hand. */
function handClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** Freezes setTimeout & co (setImmediate stays real) so only microtasks and I/O-free work can run. */
const freezeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

/** Lets every continuation that does not wait for a timer run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Real time for notifications, which the fake delivers from a timer. */
const tick = (ms = 12) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('NotBefore and scanFirst', () => {
  it('a gate answers from the clock and never shortens a longer hold', () => {
    const clock = handClock();
    const gate = new NotBefore(clock);
    expect(gate.isOpen).toBe(true);
    gate.hold(30_000);
    gate.hold(1_000);
    clock.advance(29_999);
    expect(gate.isOpen).toBe(false);
    clock.advance(1);
    expect(gate.isOpen).toBe(true);
    gate.hold(5_000);
    gate.clear();
    expect(gate.isOpen).toBe(true);
  });

  it('scanFirst stops the scan on the first accepted advertisement and returns it', async () => {
    const fake = createFakeBle();
    fake.add({ id: 'a', name: 'A', serviceUuids: ['s'], onWrite: () => {} });
    fake.add({ id: 'b', name: 'B', serviceUuids: ['s'], onWrite: () => {} });
    const ad = await scanFirst(fake.transport, { services: ['s'], timeoutMs: null }, (x) => x.id === 'b');
    expect(ad?.id).toBe('b');
    expect(fake.isScanning()).toBe(false);
  });
});

describe('Dexcom G7', () => {
  async function connected() {
    const fake = createFakeBle();
    fake.add(createG7Simulator({ glucose: { messageTimestamp: 200_000, age: 4, glucose: 141, trend: 0.3 } }));
    const clock = handClock();
    const ctx: DeviceContext = { clock, log: silentLogger, fetch: (() => Promise.reject(new Error('no fetch'))) as unknown as typeof fetch, ble: fake.transport, secrets: createMemorySecretStore() };
    const source = createDexcomG7Source({ sensorName: 'DXCM1A' }, ctx); // default timing: 30 s reconnect delay
    await source.start();
    await vi.waitFor(() => expect(fake.connectedIds()).toEqual(['g7-sim']));
    await vi.waitFor(async () => expect((await source.readings(0)).length).toBeGreaterThan(0));
    return { fake, clock, source };
  }

  it('arms the next scan the moment the link ends: service filter, no timeout, no timer involved', async () => {
    const { fake, source } = await connected();
    expect(fake.scanCalls).toHaveLength(1);
    freezeTimers();
    fake.dropLink('g7-sim');
    await settle();
    expect(fake.isScanning()).toBe(true);
    expect(fake.scanCalls).toHaveLength(2);
    expect(fake.scanCalls[1]).toMatchObject({ services: [ADVERTISEMENT_SERVICE], timeoutMs: null });
    vi.useRealTimers();
    await source.stop();
  });

  it('ignores advertisements until the 30 s reconnect delay has passed, judged by the clock when they arrive', async () => {
    const { fake, clock, source } = await connected();
    freezeTimers();
    fake.dropLink('g7-sim');
    await settle();
    // the sensor is still advertising right after its link ended (the scan reports it at once): ignored
    expect(fake.connectCalls).toHaveLength(1);
    clock.advance(29_000);
    fake.advertise('g7-sim');
    await settle();
    expect(fake.connectCalls).toHaveLength(1);
    expect(fake.isScanning()).toBe(true);
    clock.advance(2_000);
    fake.advertise('g7-sim');
    await settle();
    expect(fake.connectCalls).toHaveLength(2);
    vi.useRealTimers();
    await source.stop();
  });

  it('fires the CGM heartbeat for new readings and when the link ends, not for a duplicate', async () => {
    const fake = createFakeBle();
    fake.add(createG7Simulator({ glucose: { messageTimestamp: 200_000, age: 4, glucose: 141, trend: 0.3 } }));
    const ctx: DeviceContext = { clock: handClock(), log: silentLogger, fetch: globalThis.fetch, ble: fake.transport, secrets: createMemorySecretStore() };
    const source = createDexcomG7Source({ sensorName: 'DXCM1A' }, ctx);
    let beats = 0;
    const off = source.onHeartbeat!(() => void beats++);
    await source.start();
    await vi.waitFor(() => expect(beats).toBeGreaterThanOrEqual(1)); // the reading
    const afterReading = beats;
    fake.dropLink('g7-sim');
    await vi.waitFor(() => expect(beats).toBeGreaterThan(afterReading)); // the link ended
    off();
    const final = beats;
    fake.dropLink('g7-sim');
    await settle();
    expect(beats).toBe(final);
    await source.stop();
  });
});

describe('Dexcom G6', () => {
  it('re-arms an unbounded scan at once and holds advertisements back for the 2 s rescan delay', async () => {
    const fake = createFakeBle();
    const currentTime = 2_000_000;
    const sim = createG6Simulator({ transmitterId: '8G1234', mode: 'passive', currentTime, sessionStartTime: 1_500_000, glucose: { timestamp: currentTime - 30, glucose: 138, trend: 25 } });
    fake.add(sim);
    const clock = handClock();
    const ctx: DeviceContext = { clock, log: silentLogger, fetch: globalThis.fetch, ble: fake.transport, secrets: createMemorySecretStore() };
    const source = createDexcomG6Source({ transmitterId: '8G1234', passiveMode: true }, ctx);
    await source.start();
    await vi.waitFor(() => expect(fake.connectedIds()).toEqual([sim.id]));
    freezeTimers();
    fake.dropLink(sim.id);
    await settle();
    expect(fake.scanCalls.at(-1)).toMatchObject({ services: [ADVERTISEMENT_SERVICE], timeoutMs: null });
    expect(fake.isScanning()).toBe(true);
    expect(fake.connectCalls).toHaveLength(1); // the advertisement the new scan saw first is too early
    clock.advance(2_500);
    fake.advertise(sim.id);
    await settle();
    expect(fake.connectCalls).toHaveLength(2);
    vi.useRealTimers();
    await source.stop();
  });
});

describe('Libre session (Libre 2 direct and the MiaoMiao / Bubble transmitters)', () => {
  const SERVICE = '0000aaaa-0000-1000-8000-00805f9b34fb';
  const NOTIFY = '0000aaab-0000-1000-8000-00805f9b34fb';
  const WRITE = '0000aaac-0000-1000-8000-00805f9b34fb';

  function sessionRig(reconnectDelayMs: number) {
    const fake = createFakeBle();
    fake.add({ id: 'libre-dev', name: 'LIBRE', serviceUuids: [SERVICE], onWrite: () => {} });
    const clock = handClock();
    const protocol: SessionProtocol = {
      service: SERVICE,
      writeCharacteristic: WRITE,
      notifyCharacteristic: NOTIFY,
      reconnectDelayMs: () => reconnectDelayMs,
      matches: (ad) => ad.name === 'LIBRE',
      afterSubscribe: async () => [],
      onNotify: async () => [],
      reset: () => {},
    };
    let ended = 0;
    const session = new LibreBleSession({ ble: fake.transport, clock, log: silentLogger, protocol, loadDeviceId: async () => 'libre-dev', saveDeviceId: async () => {}, onLinkEnded: () => void ended++ });
    return { fake, clock, session, ended: () => ended };
  }

  it('no delay owed: a pending connect to the known peripheral is armed at once, with no timeout and no timer', async () => {
    const { fake, session, ended } = sessionRig(0);
    await session.start();
    expect(fake.connectCalls[0]!.options?.timeoutMs).toBe(30_000); // the first connection keeps its finite timeout
    fake.setInRange('libre-dev', false);
    freezeTimers();
    fake.dropLink('libre-dev');
    await settle();
    expect(fake.pendingConnects()).toEqual(['libre-dev']);
    expect(fake.connectCalls.at(-1)!.options?.timeoutMs).toBeNull();
    expect(fake.scanCalls).toHaveLength(0);
    expect(ended()).toBe(1);
    fake.setInRange('libre-dev', true); // the sensor is back: the pending connect completes
    await settle();
    expect(session.connected).toBe(true);
    vi.useRealTimers();
    await session.stop();
  });

  it('a 7 s delay owed (MiaoMiao / Bubble): an unbounded scan that ignores the transmitter until 7 s have passed', async () => {
    const { fake, clock, session } = sessionRig(7_000);
    await session.start();
    freezeTimers();
    fake.dropLink('libre-dev');
    await settle();
    expect(fake.isScanning()).toBe(true);
    expect(fake.scanCalls.at(-1)).toMatchObject({ services: [SERVICE], timeoutMs: null });
    expect(fake.connectCalls).toHaveLength(1);
    clock.advance(6_000);
    fake.advertise('libre-dev');
    await settle();
    expect(fake.connectCalls).toHaveLength(1);
    clock.advance(1_500);
    fake.advertise('libre-dev');
    await settle();
    expect(fake.connectCalls).toHaveLength(2);
    expect(fake.connectCalls[1]!.options?.timeoutMs).toBeNull();
    expect(session.connected).toBe(true);
    vi.useRealTimers();
    await session.stop();
  });

  it('a first connect that fails still arms a pending connect and keeps the error for the UI', async () => {
    const { fake, session } = sessionRig(0);
    const real = fake.transport.connect;
    let fail = true;
    fake.transport.connect = (id, options) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('out of range'));
      }
      return real(id, options);
    };
    fake.setInRange('libre-dev', false);
    await session.start(); // does not reject
    await settle();
    expect(session.lastError).toBe('out of range');
    expect(fake.pendingConnects()).toEqual(['libre-dev']);
    fake.setInRange('libre-dev', true);
    await settle();
    expect(session.connected).toBe(true);
    expect(session.lastError).toBeNull();
    await session.stop();
  });

  it('a reconnect that threw is re-armed at once, with no timer, while Bluetooth is on', async () => {
    const { fake, session } = sessionRig(0);
    await session.start();
    const real = fake.transport.connect;
    let fail = true;
    fake.transport.connect = (id, options) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('connect error'));
      }
      return real(id, options);
    };
    fake.setInRange('libre-dev', false);
    freezeTimers();
    fake.dropLink('libre-dev');
    await settle();
    expect(session.lastError).toBe('connect error');
    expect(fake.pendingConnects()).toEqual(['libre-dev']); // the retry is armed while every timer is frozen
    vi.useRealTimers();
    await session.stop();
  });

  it('stop() cancels a pending connect, so the sensor is not picked up again afterwards', async () => {
    const { fake, session } = sessionRig(0);
    await session.start();
    fake.setInRange('libre-dev', false);
    fake.dropLink('libre-dev');
    await settle();
    expect(fake.pendingConnects()).toEqual(['libre-dev']);
    await session.stop();
    await settle();
    expect(fake.pendingConnects()).toEqual([]);
    fake.setInRange('libre-dev', true);
    await settle();
    expect(session.connected).toBe(false);
  });
});

describe('Libre 3', () => {
  it('reconnects through a pending connect without timeout, armed before any timer fires', async () => {
    const r = await rig({ timing: { reconnectDelayMs: () => 0 } });
    await r.source.start();
    const calls = r.h.ble.connectCalls.length;
    r.h.ble.setInRange('libre3-sim', false);
    freezeTimers();
    r.h.ble.dropLink('libre3-sim');
    await settle();
    expect(r.h.ble.pendingConnects()).toEqual(['libre3-sim']);
    expect(r.h.ble.connectCalls).toHaveLength(calls + 1);
    expect(r.h.ble.connectCalls.at(-1)!.options?.timeoutMs).toBeNull();
    vi.useRealTimers();
    r.h.ble.setInRange('libre3-sim', true);
    await waitFor(() => r.source.status().phase === 'streaming' && r.h.ble.connectedIds().length === 1, 'reconnected');
    await r.source.stop();
    expect(r.h.ble.pendingConnects()).toEqual([]);
  });

  it('stop() while a connect is pending cancels it', async () => {
    const r = await rig({ timing: { reconnectDelayMs: () => 0 } });
    await r.source.start();
    r.h.ble.setInRange('libre3-sim', false);
    r.h.ble.dropLink('libre3-sim');
    await settle();
    expect(r.h.ble.pendingConnects()).toEqual(['libre3-sim']);
    await r.source.stop();
    expect(r.h.ble.pendingConnects()).toEqual([]);
  });
});

describe('Syai Ultra', () => {
  const MAC = 'AABBCCDDEEFF';
  const KEY_GROUP = Uint8Array.from({ length: 96 }, (_, i) => (i * 3 + 11) & 0xff);
  const ACTIVATED_AT = 1_780_000_000_000;
  const settings: SyaiSettings = { email: 'me@example.com', password: 'hunter2-Secret', sensorMac: '' };

  it('reconnects a dropped link through a pending connect to the known peripheral, with no timer in between', async () => {
    const ble = createFakeBle();
    const sensor = createSyaiSimulator({ mac: MAC, keyGroup: KEY_GROUP, liveIndex: 200 });
    ble.add(sensor);
    const clock = { now: () => Date.now() };
    const cloud = createSyaiCloudSim({
      clock,
      email: settings.email,
      password: settings.password,
      sensor: { mac: MAC, keyGroup: KEY_GROUP, coefficients: linearCoefficients(), produceTime: 1_770_000_000_000, coeffUpdateTime: 1_770_346_120_828, activeTime: Date.now() - 200 * 60_000 },
    });
    const ctx: DeviceContext = { clock, log: silentLogger, fetch: cloud.fetch, ble: ble.transport, secrets: createMemorySecretStore() };
    const source = createSyaiSource(settings, ctx, {
      timing: { staleLinkMs: 60_000, droppedRetryMs: 15, noSensorRetryMs: 15, authRetryMs: 15, cloudRetryMs: 15, bluetoothRetryMs: 15, replacementCheckMs: 15 },
      sessionTimeouts: { scanMs: 200, connectMs: 200 },
    });
    await source.start();
    await waitFor(() => source.status().connected, 'first link');
    await new Promise((r) => setTimeout(r, 40)); // the link lived longer than the flap guard
    ble.setInRange(sensor.id, false);
    const calls = ble.connectCalls.length;
    freezeTimers();
    ble.dropLink(sensor.id);
    await settle();
    expect(ble.pendingConnects()).toEqual([sensor.id]);
    expect(ble.connectCalls).toHaveLength(calls + 1);
    expect(ble.connectCalls.at(-1)!.options?.timeoutMs).toBeNull();
    vi.useRealTimers();
    await source.stop(); // cancels the pending connect
    expect(ble.pendingConnects()).toEqual([]);
  });
});

describe('Heartbeat transmitter', () => {
  function beaconRig(inRange = true) {
    const fake = createFakeBle();
    fake.add({ id: 'beacon', name: 'Beacon', serviceUuids: ['0000ffe0-0000-1000-8000-00805f9b34fb'], onWrite: () => {} });
    if (!inRange) fake.setInRange('beacon', false);
    const clock = handClock();
    let beats = 0;
    const transmitter = new HeartbeatTransmitter({ ble: fake.transport, clock, log: silentLogger, deviceId: 'beacon', onHeartbeat: () => void beats++ });
    return { fake, clock, transmitter, beats: () => beats };
  }

  it('keeps a pending connect with no timeout while the device is away and beats when it connects', async () => {
    const { fake, transmitter, beats } = beaconRig(false);
    transmitter.start();
    await settle();
    expect(fake.pendingConnects()).toEqual(['beacon']);
    expect(fake.connectCalls[0]!.options?.timeoutMs).toBeNull();
    expect(beats()).toBe(0);
    fake.setInRange('beacon', true);
    await settle();
    expect(transmitter.connected).toBe(true);
    expect(beats()).toBe(1);
    await transmitter.stop();
  });

  it('beats for notifications (throttled), and for the disconnect, then arms the next connect in the same turn', async () => {
    const { fake, clock, transmitter, beats } = beaconRig();
    transmitter.start();
    await settle();
    expect(beats()).toBe(1);
    const data = new Uint8Array([1]);
    fake.notifyFrom('beacon', 's', 'c', data);
    await tick();
    expect(beats()).toBe(2);
    fake.notifyFrom('beacon', 's', 'c', data); // within 5 s of the last notification beat
    await tick();
    expect(beats()).toBe(2);
    clock.advance(6_000);
    fake.notifyFrom('beacon', 's', 'c', data);
    await tick();
    expect(beats()).toBe(3);

    fake.setInRange('beacon', false);
    freezeTimers();
    fake.dropLink('beacon');
    await settle();
    expect(beats()).toBe(4); // the disconnect
    expect(fake.pendingConnects()).toEqual(['beacon']); // re-armed with every timer frozen
    expect(transmitter.connected).toBe(false);
    vi.useRealTimers();
    await transmitter.stop();
    expect(fake.pendingConnects()).toEqual([]);
  });

  it('a listener that throws does not break the transmitter', async () => {
    const fake = createFakeBle();
    fake.add({ id: 'beacon', name: 'Beacon', serviceUuids: [], onWrite: () => {} });
    const transmitter = new HeartbeatTransmitter({
      ble: fake.transport,
      clock: handClock(),
      log: silentLogger,
      deviceId: 'beacon',
      onHeartbeat: () => {
        throw new Error('listener failed');
      },
    });
    transmitter.start();
    await settle();
    expect(transmitter.connected).toBe(true);
    await transmitter.stop();
  });

  it('scanNearbyDevices lists named devices only, strongest first, one entry per device', async () => {
    const ads: BleAdvertisement[] = [
      { id: 'a', name: 'Far', rssi: -90, serviceUuids: [], manufacturerData: null },
      { id: 'b', name: 'Near', rssi: -50, serviceUuids: [], manufacturerData: null },
      { id: 'c', name: null, rssi: -40, serviceUuids: [], manufacturerData: null },
      { id: 'a', name: 'Far', rssi: -70, serviceUuids: [], manufacturerData: null },
    ];
    const ble = { scan: async (_options: unknown, onAd: (ad: BleAdvertisement) => void) => ads.forEach(onAd) } as unknown as BleTransport;
    const seen: number[] = [];
    const found = await scanNearbyDevices(ble, { durationMs: 10, onFound: (d) => seen.push(d.length) });
    expect(found).toEqual([
      { id: 'b', name: 'Near', rssi: -50 },
      { id: 'a', name: 'Far', rssi: -70 },
    ]);
    expect(seen).toEqual([1, 2]);
  });
});

