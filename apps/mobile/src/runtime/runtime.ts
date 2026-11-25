import { create } from 'zustand';
import Storage from 'expo-sqlite/kv-store';
import {
  createLoopEngine,
  createMemoryStore,
  guardManualBolus,
  newId,
  normalizeSettings,
  systemClock,
  EMPTY_SNAPSHOT,
  HOUR,
  MINUTE,
  type AlgorithmPlugin,
  type CgmSource,
  type Clock,
  type DataSnapshot,
  type LoopEngine,
  type LoopRun,
  type PumpDriver,
  type PumpState,
} from '@buddy/core';
import { createAlgorithmRegistry } from '@buddy/algorithms';
import { createCgmRegistry, createPumpRegistry, demoHub, pairSensor, parseNightscoutProfile } from '@buddy/devices';
import { loadSecrets } from './secrets';
import { processAlerts, uploadToNightscout } from './services';
import { bleTransport } from './transports/ble';
import { nfcTransport } from './transports/nfc';
import { keychainSecretStore } from './transports/secret-store';
import { useSettings } from './settings-store';

/**
 * The app runtime wires settings → plugins → LoopEngine and schedules loop cycles.
 * UI code never talks to devices directly; it calls the actions below.
 */

export const algorithms = createAlgorithmRegistry();
export const pumps = createPumpRegistry();
export const cgms = createCgmRegistry();
export const store = createMemoryStore();

const DATA_KEY = 'buddy.data.v1';
const LOOP_INTERVAL = 5 * MINUTE;
const REAL_POLL_MS = 30_000;
const PERSIST_DEBOUNCE_MS = 5_000;
const KEEP_HISTORY = 26 * HOUR;

export interface RuntimeStatus {
  readonly ready: boolean;
  readonly demo: boolean;
  readonly now: number;
  readonly looping: boolean;
  readonly pump: PumpState | null;
  readonly deviceError: string | null;
  /** Closed loop was requested but is not allowed with this device combination. */
  readonly closedLoopBlocked: string | null;
}

export const useRuntime = create<RuntimeStatus>(() => ({
  ready: false,
  demo: true,
  now: Date.now(),
  looping: false,
  pump: null,
  deviceError: null,
  closedLoopBlocked: null,
}));

let clock: Clock = systemClock;
let pump: PumpDriver | null = null;
let cgm: CgmSource | null = null;
let engine: LoopEngine | null = null;
let stopScheduler: (() => void) | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribePersist: (() => void) | null = null;

const log = {
  info: (m: string) => console.log(`[buddy] ${m}`),
  warn: (m: string) => console.warn(`[buddy] ${m}`),
  error: (m: string) => console.warn(`[buddy] ${m}`),
};

export function currentAlgorithm(): AlgorithmPlugin {
  const s = useSettings.getState();
  return algorithms.get(s.algorithmId) ?? algorithms.require('oref-smb');
}

export function algorithmSettingsFor(a: AlgorithmPlugin) {
  return normalizeSettings(a.settings, a.defaultSettings, useSettings.getState().algorithmSettings[a.meta.id]);
}

function closedLoopBlockReason(): string | null {
  const s = useSettings.getState();
  const pumpMeta = s.pumpId ? pumps.get(s.pumpId)?.meta : undefined;
  const cgmMeta = s.cgmId ? cgms.get(s.cgmId)?.meta : undefined;
  if (!pumpMeta || !cgmMeta) return 'No pump or CGM configured.';
  if (pumpMeta.readOnly) return 'Shadow mode: Buddy follows your running loop and only suggests. It never doses.';
  if (pumpMeta.maturity === 'simulator' && cgmMeta.maturity !== 'simulator')
    return 'Closed loop needs pump and CGM from the same world: a demo pump cannot dose against real glucose.';
  if (pumpMeta.requiresHardwareCheck && !s.hardwareChecks[pumpMeta.id])
    return `${pumpMeta.name} is an experimental driver. Complete the hardware check (pump not attached to your body) to enable closed loop.`;
  return null;
}

/** Builds the configured devices. An empty id means "no device" (Trio's "Add pump" state). */
async function buildDevices() {
  const s = useSettings.getState();
  const pumpPlugin = s.pumpId ? pumps.get(s.pumpId) : undefined;
  const cgmPlugin = s.cgmId ? cgms.get(s.cgmId) : undefined;
  const demo = pumpPlugin?.meta.maturity === 'simulator' || cgmPlugin?.meta.maturity === 'simulator';
  clock = demo ? demoHub.clock : systemClock;
  const ctx = { clock, log, fetch: globalThis.fetch.bind(globalThis), ble: bleTransport, nfc: nfcTransport, secrets: keychainSecretStore };
  const settingsFor = async (p: NonNullable<typeof pumpPlugin> | NonNullable<typeof cgmPlugin>) => ({
    ...normalizeSettings(p.settings, p.defaultSettings, s.deviceSettings[p.meta.id]),
    ...(await loadSecrets(p.meta.id, p.settings)),
  });
  pump = pumpPlugin ? pumpPlugin.create(await settingsFor(pumpPlugin), ctx) : null;
  cgm = cgmPlugin ? cgmPlugin.create(await settingsFor(cgmPlugin), ctx) : null;
  if (pump) await pump.connect();
  if (cgm) await cgm.start();
  return demo;
}

function createEngine() {
  if (!pump || !cgm) return null;
  return createLoopEngine({
    clock,
    pump,
    cgm,
    store,
    log,
    config: () => {
      const s = useSettings.getState();
      const algorithm = currentAlgorithm();
      const blocked = closedLoopBlockReason();
      return {
        mode: s.loopMode === 'closed' && !blocked ? 'closed' : 'open',
        algorithm,
        algorithmSettings: algorithmSettingsFor(algorithm),
        profile: s.profile,
        limits: s.limits,
        tempTarget: s.tempTarget
          ? {
              low: s.tempTarget.target,
              high: s.tempTarget.target,
              startsAt: s.tempTarget.startedAt,
              endsAt: s.tempTarget.startedAt + s.tempTarget.durationMin * MINUTE,
              halfBasalTarget: (s.tempTarget as { halfBasalTarget?: number }).halfBasalTarget,
            }
          : undefined,
        override: s.override,
      };
    },
  });
}

/** Runs one loop cycle now (also used by pull-to-refresh). */
export async function runLoop(): Promise<LoopRun | null> {
  if (!engine) return null;
  useRuntime.setState({ looping: true });
  try {
    const run = await engine.run();
    const pumpState = pump ? await pump.status().catch(() => null) : null;
    useRuntime.setState({ pump: pumpState, deviceError: run?.error ?? null, now: clock.now() });
    void afterLoop(pumpState);
    return run;
  } finally {
    useRuntime.setState({ looping: false });
  }
}

async function afterLoop(pumpState: PumpState | null) {
  const snap = store.snapshot();
  const now = clock.now();
  const lastRun = snap.loopRuns.at(-1) ?? null;
  const lastOk = [...snap.loopRuns].reverse().find((r) => !r.error)?.date ?? null;
  await processAlerts(now, { glucose: snap.glucose.slice(-48), lastRun, lastOk, pump: pumpState }).catch((e) => log.warn(`Alerts failed: ${String(e)}`));
  if (useRuntime.getState().demo) return;
  const s = useSettings.getState();
  await uploadToNightscout(() => clock.now(), {
    glucose: snap.glucose,
    doses: snap.doses,
    carbs: snap.carbs,
    loopRuns: snap.loopRuns,
    pump: pumpState,
    tempTargets: s.tempTarget ? [s.tempTarget] : [],
    overrides: s.override ? [s.override] : [],
  }).catch((e) => log.warn(`Nightscout upload failed: ${String(e)}`));
}

function lastRunDate(): number {
  return store.snapshot().loopRuns.at(-1)?.date ?? 0;
}

function startScheduler(demo: boolean) {
  stopScheduler?.();
  const maybeRun = () => {
    useRuntime.setState({ now: clock.now() });
    const latestGlucose = store.snapshot().glucose.at(-1)?.date ?? 0;
    if (clock.now() - lastRunDate() >= LOOP_INTERVAL || latestGlucose > lastRunDate()) void runLoop();
  };
  if (demo) {
    demoHub.start();
    const off = demoHub.onTick(maybeRun);
    stopScheduler = () => {
      off();
      demoHub.stop();
    };
  } else {
    const id = setInterval(maybeRun, REAL_POLL_MS);
    stopScheduler = () => clearInterval(id);
  }
}

function schedulePersist(demo: boolean) {
  unsubscribePersist?.();
  unsubscribePersist = store.subscribe((snap) => {
    if (demo) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const cutoff = clock.now() - KEEP_HISTORY;
      const pruned: DataSnapshot = {
        glucose: snap.glucose.filter((g) => g.date >= cutoff),
        doses: snap.doses.filter((d) => d.date >= cutoff),
        carbs: snap.carbs.filter((c) => c.date >= cutoff),
        loopRuns: snap.loopRuns.filter((r) => r.date >= cutoff).slice(-100),
      };
      void Storage.setItem(DATA_KEY, JSON.stringify(pruned));
    }, PERSIST_DEBOUNCE_MS);
  });
}

async function restoreData(demo: boolean) {
  if (demo) {
    store.replace(EMPTY_SNAPSHOT);
    return;
  }
  try {
    const raw = await Storage.getItem(DATA_KEY);
    if (raw) store.replace(JSON.parse(raw) as DataSnapshot);
  } catch (e) {
    log.warn(`Could not restore data: ${String(e)}`);
  }
}

let starting: Promise<void> | null = null;

/** (Re)starts the runtime after settings that affect devices changed. */
export function restartRuntime(): Promise<void> {
  starting = (async () => {
    stopScheduler?.();
    useRuntime.setState({ ready: false });
    try {
      demoHub.reset();
      const demo = await buildDevices();
      await restoreData(demo);
      engine = createEngine();
      schedulePersist(demo);
      useRuntime.setState({ ready: true, demo, deviceError: null, closedLoopBlocked: closedLoopBlockReason(), now: clock.now(), pump: pump ? await pump.status().catch(() => null) : null });
      startScheduler(demo);
      await runLoop();
    } catch (e) {
      useRuntime.setState({ ready: true, deviceError: e instanceof Error ? e.message : String(e) });
    }
  })();
  return starting;
}

export const startRuntime = () => starting ?? restartRuntime();

export const now = () => clock.now();

// ── User actions ─────────────────────────────────────────────────────────────

export async function logCarbs(grams: number, absorptionHours = 3): Promise<void> {
  if (!(grams > 0 && grams <= 300)) throw new Error('Carbs must be between 1 and 300 g');
  store.addCarbs({ id: newId('carbs'), date: clock.now(), grams, absorptionHours });
  if (useRuntime.getState().demo) demoHub.eat(grams);
}

export async function deliverBolus(units: number): Promise<number> {
  if (!pump) throw new Error('No pump connected');
  const s = useSettings.getState();
  const status = await pump.status();
  const { units: allowed } = guardManualBolus(units, s.limits.maxBolus, status.bolusIncrement);
  if (allowed <= 0) throw new Error('Bolus amount too small');
  const r = await pump.bolus(allowed, { automatic: false });
  if (!r.ok) throw new Error(r.error);
  store.addDoses(await pump.history(clock.now() - HOUR));
  return allowed;
}

export async function setPumpSuspended(suspended: boolean): Promise<void> {
  if (!pump) return;
  const r = suspended ? await pump.suspend() : await pump.resume();
  if (!r.ok) throw new Error(r.error);
  store.addDoses(await pump.history(clock.now() - HOUR));
  useRuntime.setState({ pump: await pump.status() });
}

/** Re-evaluates closed-loop eligibility after settings changes. */
export function currentPump(): PumpDriver | null {
  return pump;
}

export function refreshEligibility() {
  useRuntime.setState({ closedLoopBlocked: closedLoopBlockReason() });
}

/** Imports the active profile from the configured Nightscout site (follower or CGM settings). */
export async function importNightscoutProfile(): Promise<void> {
  const s = useSettings.getState();
  const id = ['nightscout-follower', 'nightscout-cgm'].find((k) => String(s.deviceSettings[k]?.url ?? '').startsWith('https://'));
  if (!id) throw new Error('Configure a Nightscout URL first (Settings → Pump → Follow Trio, or CGM → Nightscout).');
  const plugin = (pumps.get(id) ?? cgms.get(id))!;
  const { token } = await loadSecrets(id, plugin.settings);
  const base = String(s.deviceSettings[id]!.url).replace(/\/+$/, '');
  const q = token ? `?token=${encodeURIComponent(String(token))}` : '';
  const res = await fetch(`${base}/api/v1/profile.json${q}`);
  if (!res.ok) throw new Error(`Nightscout HTTP ${res.status}`);
  const imported = parseNightscoutProfile(await res.json());
  s.update({ profile: { ...s.profile, ...imported } });
}

/** Libre 2: reads the sensor via NFC, enables Bluetooth streaming and stores the pairing. */
export async function pairLibreSensor(): Promise<string> {
  const info = await pairSensor({ nfc: nfcTransport, secrets: keychainSecretStore, log });
  return `Sensor ${info.serialNumber} (${String(info.sensorType)}) paired${info.streamingEnabled ? ', Bluetooth streaming enabled' : ''}.`;
}
