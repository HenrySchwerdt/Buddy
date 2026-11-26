import { create } from 'zustand';
import Storage from 'expo-sqlite/kv-store';
import {
  createLoopEngine,
  createMemoryStore,
  guardManualBolus,
  migrateSnapshot,
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
import { createCgmRegistry, createPumpRegistry, demoHub, installAppIdentities, Libre3PairingError, pairLibre3Sensor, pairSensor, parseNightscoutProfile } from '@buddy/devices';
import { startNativeServices } from './background'; // native-services
import type { SensorSession } from '@buddy/nightscout';
import { loadSecrets } from './secrets';
import { processAlerts, uploadToNightscout } from './services';
import { bleTransport } from './transports/ble';
import { nfcTransport } from './transports/nfc';
import { keychainSecretStore } from './transports/secret-store';
import { xdripBridge } from './transports/xdrip'; // xdrip-cgm: native bridge, consumed by the xdrip CGM plugin
import { useSettings } from './settings-store';
import { closedLoopBlockReason as gateClosedLoop } from './closed-loop-gate';
import { checkBolusSafety } from './bolus-safety';
import { archiveKey, chunkSignature, dayOf, KEEP_HISTORY_MS, mergeHistory, planArchive, recentPart, type DayChunk } from './history-archive';
import { createBolusGate, recordDeliveredBolus, withBolusProgress } from './bolus-tracking';
import { useBolusTracker } from '../features/home/bolus-progress';
import { runPostLoopServices, startServices } from './start-services';
import type { ServiceHost } from './service-host';
import { useTreatmentSettings } from '../features/treatment/settings-store';

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
  const settings = normalizeSettings(a.settings, a.defaultSettings, useSettings.getState().algorithmSettings[a.meta.id]);
  // Max COB is edited once under Units and Limits (as in Trio) and shared with any algorithm that reads it.
  return 'maxCOB' in settings ? { ...settings, maxCOB: useTreatmentSettings.getState().maxCOB } : settings;
}

function closedLoopBlockReason(): string | null {
  const s = useSettings.getState();
  const pumpMeta = s.pumpId ? pumps.get(s.pumpId)?.meta : undefined;
  const cgmMeta = s.cgmId ? cgms.get(s.cgmId)?.meta : undefined;
  return gateClosedLoop(pumpMeta, cgmMeta);
}

/** Builds the configured devices. An empty id means "no device" (Trio's "Add pump" state). */
async function buildDevices() {
  const s = useSettings.getState();
  const pumpPlugin = s.pumpId ? pumps.get(s.pumpId) : undefined;
  const cgmPlugin = s.cgmId ? cgms.get(s.cgmId) : undefined;
  const demo = pumpPlugin?.meta.maturity === 'simulator' || cgmPlugin?.meta.maturity === 'simulator';
  clock = demo ? demoHub.clock : systemClock;
  const ctx = { clock, log, fetch: globalThis.fetch.bind(globalThis), ble: bleTransport, nfc: nfcTransport, secrets: keychainSecretStore, xdrip: xdripBridge }; // xdrip: extra ctx key read by the xdrip CGM plugin
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

const serviceHost: ServiceHost = {
  store,
  now: () => clock.now(),
  isDemo: () => useRuntime.getState().demo,
  runLoop: () => runLoop(),
  remoteProfile: async () => (await import('./remote-control/wiring')).remoteProfileFields(),
};

async function afterLoop(pumpState: PumpState | null) {
  const snap = store.snapshot();
  const now = clock.now();
  const lastRun = snap.loopRuns.at(-1) ?? null;
  const lastOk = [...snap.loopRuns].reverse().find((r) => !r.error)?.date ?? null;
  await processAlerts(now, { glucose: snap.glucose.slice(-48), lastRun, lastOk, pump: pumpState }).catch((e) => log.warn(`Alerts failed: ${String(e)}`));
  if (useRuntime.getState().demo) return;
  const s = useSettings.getState();
  void runPostLoopServices(serviceHost, pumpState?.bolusIncrement);
  // The store keeps months of history; uploads only look at the recent part (older data went up long ago).
  const recent = recentPart(snap, now);
  await uploadToNightscout(() => clock.now(), {
    glucose: recent.glucose,
    doses: recent.doses,
    carbs: recent.carbs,
    loopRuns: recent.loopRuns,
    pump: pumpState,
    tempTargets: s.tempTarget ? [s.tempTarget] : [],
    overrides: s.override ? [s.override] : [],
    sensors: sensorSessions(),
  }).catch((e) => log.warn(`Nightscout upload failed: ${String(e)}`));
}

/**
 * CGM sensor session starts for Nightscout. A CGM driver that knows its session start implements the optional
 * `sensorSession()` method; drivers without it simply upload no sensor notes.
 */
function sensorSessions(): SensorSession[] {
  const session = (cgm as { sensorSession?: () => SensorSession | null } | null)?.sensorSession?.();
  return session ? [session] : [];
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

/** Day chunks of the long history already stored, by UTC day (signature of what was written). */
let storedDays = new Map<number, string>();
let archiveTimer: ReturnType<typeof setTimeout> | null = null;
const ARCHIVE_DEBOUNCE_MS = 60_000;

/** Writes the days of the long history that changed since the last write; removes days that emptied or aged out. */
async function writeArchive(): Promise<void> {
  const snap = store.snapshot();
  const plan = planArchive(snap, clock.now(), storedDays);
  try {
    for (const [day, chunk] of plan.write) await Storage.setItem(archiveKey(day), JSON.stringify(chunk));
    for (const day of plan.remove) await Storage.removeItem(archiveKey(day));
    storedDays = new Map(plan.signatures);
  } catch (e) {
    log.warn(`Could not store history: ${String(e)}`);
  }
}

function schedulePersist(demo: boolean) {
  unsubscribePersist?.();
  unsubscribePersist = store.subscribe((snap) => {
    if (demo) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void Storage.setItem(DATA_KEY, JSON.stringify(recentPart(snap, clock.now())));
      // Only walk the long history when something is older than the window.
      const cutoff = clock.now() - KEEP_HISTORY_MS;
      if (snap.glucose[0] && snap.glucose[0].date < cutoff) store.prune(cutoff);
    }, PERSIST_DEBOUNCE_MS);
    if (archiveTimer) return; // already due; the write sees the newest state
    archiveTimer = setTimeout(() => {
      archiveTimer = null;
      void writeArchive();
    }, ARCHIVE_DEBOUNCE_MS);
  });
}

async function restoreData(demo: boolean) {
  if (demo) {
    store.replace(EMPTY_SNAPSHOT);
    return;
  }
  try {
    const raw = await Storage.getItem(DATA_KEY);
    const recent = raw ? migrateSnapshot(JSON.parse(raw) as DataSnapshot) : EMPTY_SNAPSHOT;
    // Long history: one value per UTC day, oldest first.
    const now = clock.now();
    const chunks: DayChunk[] = [];
    storedDays = new Map();
    for (let day = dayOf(now - KEEP_HISTORY_MS); day <= dayOf(now); day++) {
      const text = await Storage.getItem(archiveKey(day));
      if (!text) continue;
      const chunk = JSON.parse(text) as DayChunk;
      chunks.push(chunk);
      storedDays.set(day, chunkSignature(chunk));
    }
    store.replace(migrateSnapshot(mergeHistory(recent, chunks)));
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
    startServices(serviceHost);
    try {
      demoHub.reset();
      const demo = await buildDevices();
      await restoreData(demo);
      // The demo world and its clock start over on every restart, so adjustments anchored to the
      // previous demo clock would sit in its future and switch on unexpectedly later.
      if (demo) useSettings.getState().update({ override: null, tempTarget: null });
      engine = createEngine();
      schedulePersist(demo);
      useRuntime.setState({ ready: true, demo, deviceError: null, closedLoopBlocked: closedLoopBlockReason(), now: clock.now(), pump: pump ? await pump.status().catch(() => null) : null });
      startScheduler(demo);
      // native-services: Live Activity, Android foreground service, App Intents state, background task
      startNativeServices({ real: !demo && Boolean(pump || cgm), demo, store, now: () => clock.now() });
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

export async function logCarbs(grams: number, absorptionHours = 3, note?: string): Promise<void> {
  if (!(grams > 0 && grams <= 300)) throw new Error('Carbs must be between 1 and 300 g');
  const trimmed = note?.trim();
  store.addCarbs({ id: newId('carbs'), date: clock.now(), grams, absorptionHours, ...(trimmed ? { note: trimmed } : {}) });
  if (useRuntime.getState().demo) demoHub.eat(grams);
}

const bolusGate = createBolusGate();

export function deliverBolus(units: number): Promise<number> {
  return bolusGate(() => deliverBolusNow(units));
}

async function deliverBolusNow(units: number): Promise<number> {
  if (!pump) throw new Error('No pump connected');
  const s = useSettings.getState();
  const status = await pump.status();
  // Trio BolusSafetyValidator: max bolus, IOB availability, max IOB and recent boluses (manual path only).
  const snap = store.snapshot();
  const safety = checkBolusSafety({ units, limits: s.limits, profile: s.profile, doses: snap.doses, now: clock.now() });
  if (!safety.ok) throw new Error(safety.message);
  const { units: allowed } = guardManualBolus(units, s.limits.maxBolus, status.bolusIncrement);
  if (allowed <= 0) throw new Error('Bolus amount too small');
  const p = pump;
  const startedAt = clock.now();
  const r = await withBolusProgress(useBolusTracker.getState(), p, allowed, () => clock.now(), () => p.bolus(allowed, { automatic: false }));
  if (!r.ok) throw new Error(r.error);
  await recordDeliveredBolus(store, p, allowed, startedAt, () => clock.now(), newId('bolus'));
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

/** The running CGM source (for sensor info), or null. */
export function currentCgm(): CgmSource | null {
  return cgm;
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

/** Result of a Libre 3 NFC scan: paired, or a factory-fresh sensor that needs the user's go-ahead to activate. */
export type Libre3PairResult = { readonly kind: 'paired'; readonly text: string } | { readonly kind: 'needsActivation' };

/**
 * Libre 3: installs the user's app credential (keychain only), then reads the sensor via NFC and
 * stores its Bluetooth pairing. Activating a fresh sensor starts its wear clock, so it only happens
 * when `allowActivation` is set after the user confirmed.
 */
export async function pairLibre3(credential: string, allowActivation: boolean): Promise<Libre3PairResult> {
  const json = credential.trim();
  if (json) await installAppIdentities(keychainSecretStore, json);
  try {
    const info = await pairLibre3Sensor({ nfc: nfcTransport, secrets: keychainSecretStore, log, clock: { now } }, { allowActivation });
    return { kind: 'paired', text: `Sensor ${info.serialNumber} paired${info.activated ? ', warm-up started (60 min)' : ''}.` };
  } catch (e) {
    if (e instanceof Libre3PairingError && e.code === 'activationNotAllowed') return { kind: 'needsActivation' };
    throw e;
  }
}
