/** Shared fixtures for the Libre 3 session tests: fake NFC tag, test app credential, fast timing. */
import {
  concatBytes, createMemorySecretStore, fromHex, hex, silentLogger,
  type Bytes, type DeviceContext, type Logger, type NfcIso15693Tag, type NfcTransport,
} from '@buddy/core';
import { p256 } from '@noble/curves/nist.js';
import { createLibre3Source, installAppIdentities, pairLibre3Sensor, type Libre3CgmSource } from '../src/libre3';
import { abbottCrc16 } from '../src/libre3/nfc';
import { Libre3SensorSimulator, type RealtimeSpec } from '../src/libre3/simulator';
import type { Libre3Timing } from '../src/libre3/timing';
import { createFakeBle } from '../src/testkit';

export const T0 = 1_700_000_040_000;

export function makeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
}

/** Test app credential: random P-256 key and a 162-byte certificate carrying its public point at offset 33. */
export function makeCredentialJson(...labels: string[]): { json: string; certificates: Bytes[] } {
  const certificates: Bytes[] = [];
  const identities = labels.map((label) => {
    const privateKey = p256.utils.randomSecretKey();
    const certificate = new Uint8Array(162);
    certificate.set([0x03, 0x03], 0);
    certificate.set(p256.getPublicKey(privateKey, false), 33);
    certificates.push(certificate);
    return { label, privateKeyHex: hex(privateKey), certificateHex: hex(certificate) };
  });
  return { json: JSON.stringify({ format: 1, curve: 'P-256', identities }), certificates };
}

export const FAST_TIMING: Partial<Libre3Timing> = {
  scanTimeoutMs: 50,
  connectTimeoutMs: 1_000,
  writeMs: 500,
  notifyMs: 500,
  commandMs: 500,
  watchdogIntervalMs: 3_600_000,
  historicalIdleMs: 15,
  historicalMaxWaitMs: 250,
  clinicalRetryDelaysMs: [0, 5],
  backfillPass2Ms: 60,
  authFailuresBeforeRepair: 2,
  reconnectDelayMs: () => 0,
};

const PATCH_INFO_FRESH = '00a50001000200010060541e020401040c0130525243393839415151ff17';
const PATCH_INFO_ACTIVE = '00a50001000200010060541e020401040c04305252433938394151c6ca';
export const SERIAL = '0RRC989AQ';

export interface FakeNfc {
  readonly nfc: NfcTransport;
  readonly commands: { code: number; params: string }[];
  touched: number;
}

/** Libre 3 tag: patch info on 0xA1, activation / switch response (BLE address + PIN of the simulator) on 0xA0 / 0xA8. */
export function fakeLibre3Nfc(sim: Libre3SensorSimulator, state: 'fresh' | 'active'): FakeNfc {
  const commands: { code: number; params: string }[] = [];
  const fake: FakeNfc = { nfc: undefined as unknown as NfcTransport, commands, touched: 0 };
  const address = fromHex(sim.bleAddress.replace(/:/g, '')).reverse();
  const tag: NfcIso15693Tag = {
    uid: new Uint8Array(8),
    transceive: async () => {
      throw new Error('not used');
    },
    readSingleBlock: async () => {
      throw new Error('not used');
    },
    async customCommand(code, params) {
      commands.push({ code, params: hex(params) });
      if (code === 0xa1) return fromHex(state === 'fresh' ? PATCH_INFO_FRESH : PATCH_INFO_ACTIVE);
      if (code !== 0xa0 && code !== 0xa8) throw new Error('unsupported command');
      if (params.length !== 10 || abbottCrc16(params.subarray(0, 8)) !== (params[8]! | (params[9]! << 8))) throw new Error('bad CRC');
      return concatBytes(Uint8Array.of(0x00, 0xa5, 0x00), address, sim.blePin, new Uint8Array(4), Uint8Array.of(0xad, 0x06));
    },
  };
  (fake as { nfc: NfcTransport }).nfc = {
    isSupported: async () => true,
    withIso15693Tag: (_alert, session) => {
      fake.touched++;
      return session(tag);
    },
  };
  return fake;
}

export interface Harness {
  readonly ctx: DeviceContext;
  readonly clock: ReturnType<typeof makeClock>;
  readonly ble: ReturnType<typeof createFakeBle>;
  readonly secrets: ReturnType<typeof createMemorySecretStore>;
  readonly logs: string[];
}

export function makeHarness(sim?: Libre3SensorSimulator, extra: Partial<DeviceContext> = {}): Harness {
  const clock = makeClock();
  const ble = createFakeBle();
  if (sim) ble.add(sim.peripheral);
  const secrets = createMemorySecretStore();
  const logs: string[] = [];
  const log: Logger = { ...silentLogger, info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  return { ctx: { clock, log, fetch: globalThis.fetch, ble: ble.transport, secrets, ...extra }, clock, ble, secrets, logs };
}

export async function waitFor(condition: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 4));
  }
}

/** Lets queued notifications reach the driver and be processed. */
export async function flush(source: { idle(): Promise<void> }): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 6));
    await source.idle();
  }
}

export interface Rig {
  readonly sim: Libre3SensorSimulator;
  readonly h: Harness;
  readonly source: Libre3CgmSource;
}

/** Pairs over NFC (active sensor) and builds the source against a simulator whose lifeCount is past warmup. */
export async function rig(options: { settings?: Partial<{ minuteByMinute: boolean; useNonActionable: boolean }>; identities?: string[]; lifeCount?: number; timing?: Partial<Libre3Timing> } = {}): Promise<Rig> {
  const sim = new Libre3SensorSimulator({ lifeCount: options.lifeCount ?? 200 });
  const h = makeHarness(sim);
  const { json, certificates } = makeCredentialJson(...(options.identities ?? ['test']));
  await installAppIdentities(h.secrets, json);
  if (options.identities?.length === 2) sim.acceptCertificate = (cert) => hex(cert) === hex(certificates[1]!);
  await pairLibre3Sensor({ ...h.ctx, nfc: fakeLibre3Nfc(sim, 'active').nfc });
  const source = createLibre3Source(
    { minuteByMinute: false, useNonActionable: false, appCredential: '', ...options.settings },
    h.ctx,
    { timing: { ...FAST_TIMING, ...options.timing }, signingKeys: [sim.signingPublicKey] },
  );
  return { sim, h, source };
}

/** One sensor minute: emit a frame, let the driver process it, advance the phone clock. */
export async function minute(r: Rig, spec: RealtimeSpec = { mgdl: 120 }): Promise<void> {
  r.sim.tick(spec);
  await flush(r.source);
  r.h.clock.advance(60_000);
}

