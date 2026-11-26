// Test rig for the MiniMed driver, a port of MinimedKit (MIT License, (c) LoopKit Authors).
/**
 * Shared rig for the MiniMed tests: fake BLE, RileyLink simulator, pump simulator, driver and a
 * manual clock. Bench scenario only: the simulated pump delivers arithmetic, never insulin.
 */
import { createMemorySecretStore, type BleTransport, type DeviceContext, type Logger, type Millis, type SecretStore } from '@buddy/core';
import { createFakeBle, type FakeBleControls } from '../src/testkit';
import { createMinimedDriver, MINIMED_DEFAULTS, MinimedPumpBench, type MinimedDriver, type MinimedDriverOptions, type MinimedPumpBenchOptions, type MinimedSettings } from '../src/minimed';

export const START: Millis = Date.UTC(2026, 10, 25, 8, 0, 0);
export const SERIAL = '123456';

export const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2));
};

export interface MinimedRig {
  /** every log line, with its level; serial numbers must never appear in it */
  readonly allLogs: string[];
  readonly warnings: string[];
  /** while true the central cannot connect to the RileyLink */
  readonly range: { unreachable: boolean };
  readonly driver: MinimedDriver;
  readonly bench: MinimedPumpBench;
  readonly ble: FakeBleControls;
  readonly secrets: SecretStore;
  readonly clock: { t: Millis; now(): Millis };
  readonly settings: MinimedSettings;
  advance(ms: number): Promise<void>;
  newDriver(options?: MinimedDriverOptions): MinimedDriver;
}

export interface RigOptions extends Partial<MinimedPumpBenchOptions> {
  readonly settings?: Partial<MinimedSettings>;
  readonly driver?: MinimedDriverOptions;
  /** a secret store that is shared with an earlier rig (a restarted app) */
  readonly secrets?: SecretStore;
}

export function makeMinimedRig(o: RigOptions = {}): MinimedRig {
  const clock = { t: START, now: () => clock.t };
  const ble = createFakeBle();
  const bench = new MinimedPumpBench({ serial: SERIAL, model: '723', utcOffsetSeconds: 3600, ...o, clock });
  ble.add(bench.rileyLink);
  const secrets = o.secrets ?? createMemorySecretStore();
  const warnings: string[] = [];
  const allLogs: string[] = [];
  const range = { unreachable: false };
  const log: Logger = {
    info: (m) => allLogs.push(`info ${m}`),
    warn: (m) => {
      warnings.push(m);
      allLogs.push(`warn ${m}`);
    },
    error: (m) => {
      warnings.push(m);
      allLogs.push(`error ${m}`);
    },
  };
  const transport: BleTransport = {
    ...ble.transport,
    connect: (id, opts) => (range.unreachable ? Promise.reject(new Error('RileyLink out of range')) : ble.transport.connect(id, opts)),
  };
  const ctx: DeviceContext = { clock, log, fetch: globalThis.fetch, ble: transport, secrets };
  const settings: MinimedSettings = { ...MINIMED_DEFAULTS, rileyLinkId: bench.rileyLink.id, pumpSerial: SERIAL, pumpRegion: 'NA', pumpModel: bench.pump.model, ...o.settings };
  const newDriver = (options: MinimedDriverOptions = {}) =>
    createMinimedDriver(settings, ctx, {
      rileyLink: { bleLatencyMs: 200, versionTimeoutMs: 200 },
      connectTimeoutMs: 250,
      utcOffsetSeconds: () => 3600,
      responseDelayMs: 0,
      sleep: () => Promise.resolve(),
      ...o.driver,
      ...options,
    });
  return {
    driver: newDriver(),
    bench,
    ble,
    secrets,
    clock,
    settings,
    warnings,
    allLogs,
    range,
    newDriver,
    async advance(ms) {
      clock.t += ms;
      await flush();
    },
  };
}

export const bolusUnits = (doses: readonly { kind: string; units?: number }[]): number => doses.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + (d.units ?? 0) : s), 0);
