// Test rig for the port of OmnipodKit (MIT License, (c) LoopKit Authors).
/**
 * Shared rig for the Omnipod DASH tests: fake BLE, protocol simulator, driver, manual clock.
 * Bench scenario only: the simulated pod holds water and is never attached to anything.
 */
import { expect } from 'vitest';
import { createMemorySecretStore, type BleTransport, type DeviceContext, type Logger, type Millis, type SecretStore } from '@buddy/core';
import { createFakeBle, type FakeBleControls } from '../src/testkit';
import { createOmnipodDashDriver, insertCannula, OMNIPOD_DASH_DEFAULTS, OmnipodDashSimulator, pairAndPrimePod, readPodStatus, type OmnipodDashDriver } from '../src/omnipod';
import { PodProgress } from '../src/omnipod/common';
import { refreshPod } from '../src/omnipod/dash/activation';

const START: Millis = Date.UTC(2026, 10, 25, 8, 0, 0);
const SCHEDULE = [
  { startMinute: 0, value: 0.8 },
  { startMinute: 6 * 60, value: 1.1 },
];

export const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2));
};

export interface Rig {
  /** every log line (info, warn, error) */
  readonly allLogs: string[];
  /** while true the central cannot connect (the pod is out of range) */
  readonly range: { unreachable: boolean };
  readonly driver: OmnipodDashDriver;
  readonly sim: OmnipodDashSimulator;
  readonly ble: FakeBleControls;
  readonly secrets: SecretStore;
  readonly clock: { t: Millis; now(): Millis };
  readonly logs: string[];
  advance(ms: number): Promise<void>;
  newDriver(): OmnipodDashDriver;
}

export function makeRig(): Rig {
  const clock = { t: START, now: () => clock.t };
  const ble = createFakeBle();
  const sim = new OmnipodDashSimulator({ clock });
  ble.add(sim);
  const secrets = createMemorySecretStore();
  const logs: string[] = [];
  const allLogs: string[] = [];
  const range = { unreachable: false };
  const log: Logger = {
    info: (m) => allLogs.push(`info ${m}`),
    warn: (m) => {
      logs.push(`warn ${m}`);
      allLogs.push(`warn ${m}`);
    },
    error: (m) => {
      logs.push(`error ${m}`);
      allLogs.push(`error ${m}`);
    },
  };
  const transport: BleTransport = {
    ...ble.transport,
    connect: (id, o) => (range.unreachable ? Promise.reject(new Error('Pod out of range')) : ble.transport.connect(id, o)),
  };
  const ctx: DeviceContext = { clock, log, fetch: globalThis.fetch, ble: transport, secrets };
  const newDriver = () => createOmnipodDashDriver(OMNIPOD_DASH_DEFAULTS, ctx, { ioTimeoutMs: 250, scanTimeoutMs: 20, connectTimeoutMs: 250, utcOffsetSeconds: () => 3600 });
  return {
    driver: newDriver(),
    sim,
    ble,
    secrets,
    clock,
    logs,
    allLogs,
    range,
    newDriver,
    async advance(ms) {
      for (let left = ms; left > 0; left -= 2000) {
        clock.t += Math.min(2000, left);
        sim.tick();
        await flush(1);
      }
      await flush();
    },
  };
}

export async function activate(rig: Rig): Promise<void> {
  expect(await pairAndPrimePod(rig.driver)).toEqual({ ok: true });
  await rig.advance(60_000);
  expect(await refreshPod(rig.driver)).toEqual({ ok: true });
  expect((await readPodStatus(rig.driver)).podProgress).toBe(PodProgress.primingCompleted);
  expect(await insertCannula(rig.driver, SCHEDULE)).toEqual({ ok: true });
  await rig.advance(10_000);
  expect(await refreshPod(rig.driver)).toEqual({ ok: true });
  expect((await readPodStatus(rig.driver)).phase).toBe('running');
}

export { SCHEDULE, START };
