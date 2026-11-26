// Test rig for the Eros driver, a port of OmnipodKit (MIT License, (c) LoopKit Authors).
/**
 * Shared rig for the Omnipod Eros tests: fake BLE, RileyLink simulator, pod simulator, driver and a
 * manual clock. Bench scenario only: the simulated pod holds water and is never attached to anything.
 */
import { expect } from 'vitest';
import { createMemorySecretStore, type BleTransport, type DeviceContext, type Logger, type Millis, type SecretStore } from '@buddy/core';
import { createFakeBle, type FakeBleControls } from '../src/testkit';
import { createOmnipodErosDriver, ErosPodBench, insertErosCannula, OMNIPOD_EROS_DEFAULTS, pairAndPrimeErosPod, readErosPodStatus, refreshErosPod, type OmnipodErosDriver } from '../src/omnipod/eros-driver';
import { PodProgress } from '../src/omnipod/common';

export const START: Millis = Date.UTC(2026, 10, 25, 8, 0, 0);
export const SCHEDULE = [
  { startMinute: 0, value: 0.8 },
  { startMinute: 6 * 60, value: 1.1 },
];

export const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2));
};

export interface ErosRig {
  readonly allLogs: string[];
  readonly logs: string[];
  /** while true the central cannot connect to the RileyLink */
  readonly range: { unreachable: boolean };
  readonly driver: OmnipodErosDriver;
  readonly bench: ErosPodBench;
  readonly ble: FakeBleControls;
  readonly secrets: SecretStore;
  readonly clock: { t: Millis; now(): Millis };
  advance(ms: number): Promise<void>;
  newDriver(): OmnipodErosDriver;
}

export function makeErosRig(): ErosRig {
  const clock = { t: START, now: () => clock.t };
  const ble = createFakeBle();
  const bench = new ErosPodBench({ clock });
  ble.add(bench.rileyLink);
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
    connect: (id, o) => (range.unreachable ? Promise.reject(new Error('RileyLink out of range')) : ble.transport.connect(id, o)),
  };
  const ctx: DeviceContext = { clock, log, fetch: globalThis.fetch, ble: transport, secrets };
  let counter = 0;
  const newDriver = () =>
    createOmnipodErosDriver({ ...OMNIPOD_EROS_DEFAULTS, rileyLinkId: bench.rileyLink.id }, ctx, {
      transportClock: bench.airClock,
      rileyLink: { bleLatencyMs: 200, versionTimeoutMs: 200 },
      connectTimeoutMs: 250,
      scanTimeoutMs: 20,
      utcOffsetSeconds: () => 3600,
      random32: () => 0x5a5a5 + counter++,
    });
  return {
    driver: newDriver(),
    bench,
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
        bench.tick();
        await flush(1);
      }
      await flush();
    },
  };
}

export async function activateErosPod(rig: ErosRig): Promise<void> {
  expect(await pairAndPrimeErosPod(rig.driver)).toEqual({ ok: true });
  await rig.advance(60_000);
  expect(await refreshErosPod(rig.driver)).toEqual({ ok: true });
  expect((await readErosPodStatus(rig.driver)).podProgress).toBe(PodProgress.primingCompleted);
  expect(await insertErosCannula(rig.driver, SCHEDULE)).toEqual({ ok: true });
  await rig.advance(10_000);
  expect(await refreshErosPod(rig.driver)).toEqual({ ok: true });
  expect((await readErosPodStatus(rig.driver)).phase).toBe('running');
}
