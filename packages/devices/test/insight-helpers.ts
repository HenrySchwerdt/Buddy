import { createMemorySecretStore, hex, type DeviceContext, type InsulinDose, type Logger, type SecretStore } from '@buddy/core';
import { createFakeBle, type FakeBleControls, type PumpHarness } from '../src/testkit';
import { createInsightDriver, InsightBridgeSimulator, INSIGHT_DEFAULTS, type InsightPumpDriver, type InsightSettings } from '../src/insight';
import { credentialsKey, encodeCredentials } from '../src/insight/credentials';
import { stateKey } from '../src/insight/state';
import type { InsightTimeouts } from '../src/insight/constants';

export const LTK = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
export const CLIENT_ID = '0123456789abcdef';
export const BRIDGE_ID = 'fedcba9876543210';
export const START = Date.UTC(2026, 10, 25, 9, 0, 0);

export const FAST: Partial<InsightTimeouts> = { connectMs: 600, scanMs: 20, handshakeMs: 300, statusMs: 300, dosingMs: 300, pingMs: 200, pingIntervalMs: 0, pairingResponseMs: 300, pairingConfirmMs: 600 };

export interface RecordingLogger extends Logger {
  readonly lines: string[];
}
export function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  return { lines, info: (m) => void lines.push(m), warn: (m) => void lines.push(m), error: (m) => void lines.push(m) };
}

export interface Rig extends PumpHarness {
  readonly driver: InsightPumpDriver;
  readonly sim: InsightBridgeSimulator;
  readonly ble: FakeBleControls;
  readonly secrets: SecretStore;
  readonly log: RecordingLogger;
  readonly settings: InsightSettings;
  setNow(t: number): void;
  now(): number;
  /** A second driver on the same storage (an app restart). */
  restart(): InsightPumpDriver;
}

export const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

export function rig(opts: { secrets?: SecretStore; settings?: Partial<InsightSettings>; sim?: Partial<ConstructorParameters<typeof InsightBridgeSimulator>[0]>; timeouts?: Partial<InsightTimeouts>; storeless?: boolean } = {}): Rig {
  let now = START;
  const clock = { now: () => now };
  const ble = createFakeBle();
  const sim = new InsightBridgeSimulator({ clock, paired: { ltk: LTK, clientId: CLIENT_ID }, bridgeId: BRIDGE_ID, ...opts.sim });
  ble.add(sim);
  const secrets = opts.secrets ?? createMemorySecretStore({ [credentialsKey(BRIDGE_ID)]: encodeCredentials({ bridgeId: BRIDGE_ID, ltk: LTK, clientId: CLIENT_ID }) });
  const log = recordingLogger();
  const ctx: DeviceContext = { clock, log, fetch, ble: ble.transport, secrets };
  const settings: InsightSettings = { ...INSIGHT_DEFAULTS, bridgeId: BRIDGE_ID, bridgePeripheral: sim.id, basalProfile: '1.0', ...opts.settings };
  const make = () => createInsightDriver(settings, ctx, { timeouts: { ...FAST, ...opts.timeouts }, appName: 'Buddy test' });
  const driver = make();
  return {
    driver,
    sim,
    ble,
    secrets,
    log,
    settings,
    setNow: (t) => {
      now = t;
    },
    now: () => now,
    restart: make,
    async advance(ms) {
      for (let left = ms; left > 0; ) {
        const step = sim.bolus ? Math.min(1000, left) : left;
        left -= step;
        now += step;
        sim.advance(step);
        await flush();
      }
    },
    dropConnectionAfterNextCommand: () => sim.dropAfterNextDosingCommand(),
    deliveredBolusUnits: () => sim.deliveredBolusUnits(),
  };
}

export const bolusTotal = (h: readonly InsulinDose[]) => h.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + d.units : s), 0);

export async function settle(r: Rig) {
  for (let i = 0; i < 120 && (await r.driver.status()).bolusing; i++) await r.advance(5_000);
}

export const ltkHex = hex(LTK);
export { stateKey };

/** Connects and brings the cached status up to date (so the next request on the wire is the one under test). */
export async function up(r: Rig): Promise<void> {
  await r.driver.connect();
  await r.driver.status();
}
