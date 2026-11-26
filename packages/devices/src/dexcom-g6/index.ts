/**
 * Dexcom G5/G6 transmitter CGM plugin.
 *
 * The reading/state handling is a TypeScript port of TransmitterManager.swift and
 * TransmitterManagerState.swift from loopandlearn/CGMBLEKit (MIT, © 2017 LoopKit Authors).
 * Skipped on purpose: LoopKit/HealthKit glue, the Share fallback (Buddy has a separate
 * Dexcom Share plugin), CGM events, UI, and the sensor command queue (start/stop/calibrate/
 * reset transmitter) — Buddy is a read-only consumer of the CGM.
 */
import { defineCgm, HeartbeatEmitter, type Bytes, type CgmSource, type DeviceContext, type DeviceMeta, type GlucoseReading } from '@buddy/core';
import { normalizeTransmitterId } from './auth';
import { errorOf, ReadingBuffer } from './ble-common';
import { DEFAULT_SENSOR_LIFE_DAYS, g6Trend, hasReliableGlucose, calibrationStateName, type G6Glucose } from './glucose';
import { hasValidSensorSession, isAnubis, NO_ACTIVE_SESSION_START_TIME, sameGlucoseSubMessage } from './messages';
import { Transmitter, type G6Timing } from './transmitter';

export { computeHash, normalizeTransmitterId } from './auth';
export { makeGlucose, hasReliableGlucose, CalibrationState, transmitterStatus, type G6Glucose, type TransmitterStatus } from './glucose';
export * from './messages';
export * from './backfill';
export { Transmitter, DEFAULT_G6_TIMING, type G6Timing } from './transmitter';

export const DEXCOM_G6_ID = 'dexcom-g6';

export interface DexcomG6Settings {
  readonly [key: string]: string | number | boolean;
  transmitterId: string;
  passiveMode: boolean;
}

/** What TransmitterManagerState persists (besides the transmitter ID, which lives in settings). */
export interface G6PersistedState {
  /** First observed transmitter activation date (epoch ms). */
  readonly transmitterStartDate: number | null;
  readonly sensorStartOffset: number | null;
  /** Transmitter-reported lifetime in days (90 stock G6, 180 Anubis). */
  readonly transmitterExpiryInDays: number | null;
}

/** The G6 sensor warms up for two hours. */
const G6_WARMUP_MS = 2 * 3_600_000;

const EMPTY_STATE: G6PersistedState = { transmitterStartDate: null, sensorStartOffset: null, transmitterExpiryInDays: null };
export const g6StateKey = (transmitterId: string): string => `${DEXCOM_G6_ID}.state.${transmitterId}`;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseG6State(raw: string | null): G6PersistedState {
  if (!raw) return EMPTY_STATE;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return { transmitterStartDate: num(o.transmitterStartDate), sensorStartOffset: num(o.sensorStartOffset), transmitterExpiryInDays: num(o.transmitterExpiryInDays) };
  } catch {
    return EMPTY_STATE;
  }
}

const META: DeviceMeta = {
  id: DEXCOM_G6_ID,
  name: 'Dexcom G6 (Bluetooth)',
  manufacturer: 'Dexcom',
  description: 'Reads a Dexcom G5/G6 transmitter directly over Bluetooth. Follows the Dexcom app by default (passive mode).',
  transport: 'ble',
  maturity: 'experimental',
};

export interface G6SourceOptions {
  readonly timing?: Partial<G6Timing>;
  readonly randomToken?: () => Bytes;
}

export function toG6Reading(g: G6Glucose): GlucoseReading | null {
  if (!hasReliableGlucose(g.state) || g.glucose === null) return null;
  return { date: g.readDate, value: g.glucose, trend: g6Trend(g), source: DEXCOM_G6_ID };
}

export function createDexcomG6Source(settings: DexcomG6Settings, ctx: DeviceContext, options: G6SourceOptions = {}): CgmSource {
  const ble = ctx.ble;
  if (!ble) throw new Error('Dexcom G6 needs Bluetooth, but no BLE transport is available on this device');
  const transmitterId = normalizeTransmitterId(String(settings.transmitterId ?? ''));
  const passiveModeEnabled = settings.passiveMode !== false;
  const buffer = new ReadingBuffer();
  const heartbeat = new HeartbeatEmitter();
  const key = g6StateKey(transmitterId);

  let state: G6PersistedState = EMPTY_STATE;
  let latestReading: G6Glucose | null = null;
  let transmitter: Transmitter | null = null;
  let persistChain: Promise<void> = Promise.resolve();

  const setState = (next: G6PersistedState) => {
    state = next;
    const secrets = ctx.secrets;
    if (!secrets) return;
    persistChain = persistChain
      .then(() => secrets.set(key, JSON.stringify(next)))
      .catch((e: unknown) => ctx.log.error(`Dexcom G6: could not persist state: ${errorOf(e).message}`));
  };

  const sensorLifeDays = () => DEFAULT_SENSOR_LIFE_DAYS;

  const isSame = (a: G6Glucose, b: G6Glucose | null) => b !== null && sameGlucoseSubMessage(a.glucoseMessage, b.glucoseMessage) && a.syncIdentifier === b.syncIdentifier;

  const pushReading = (g: G6Glucose) => {
    const r = toG6Reading(g);
    if (r && buffer.add(g.syncIdentifier, r)) heartbeat.emit();
  };

  const delegate = {
    transmitterDidConnect: () => ctx.log.info('Dexcom G6: connected'),
    didError: (e: Error) => ctx.log.error(`Dexcom G6: ${e.message}`),
    didReadUnknownData: (d: Bytes) => ctx.log.warn(`Dexcom G6: unknown sensor data ${Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')}`),
    didReadTransmitterVersion: (message: { readonly transmitterExpiryInDays: number }) => {
      ctx.log.info(`Dexcom G6: transmitter reports expiry of ${message.transmitterExpiryInDays} days (isAnubis=${isAnubis(message)})`);
      if (transmitter) transmitter.needsExpiryRead = false;
      if (state.transmitterExpiryInDays !== message.transmitterExpiryInDays) setState({ ...state, transmitterExpiryInDays: message.transmitterExpiryInDays });
    },
    didRead: (glucose: G6Glucose) => {
      if (isSame(glucose, latestReading)) return;
      let next = state;
      if (next.transmitterStartDate === null) next = { ...next, transmitterStartDate: glucose.activationDate };
      const sensorStartOffset = hasValidSensorSession(glucose.timeMessage) ? glucose.timeMessage.sessionStartTime : NO_ACTIVE_SESSION_START_TIME;
      if (next.sensorStartOffset !== sensorStartOffset) next = { ...next, sensorStartOffset };
      if (next !== state) setState(next);
      latestReading = glucose;
      if (!hasReliableGlucose(glucose.state)) {
        ctx.log.info(`Dexcom G6: unreliable glucose (${calibrationStateName(glucose.state)})`);
        return;
      }
      pushReading(glucose);
    },
    didReadBackfill: (glucose: readonly G6Glucose[]) => {
      for (const g of glucose) if (!isSame(g, latestReading)) pushReading(g);
    },
  };

  return {
    meta: META,
    async start() {
      if (transmitter?.isRunning) return;
      if (!transmitter) {
        state = parseG6State((await ctx.secrets?.get(key)) ?? null);
        transmitter = new Transmitter({
          id: transmitterId,
          passiveModeEnabled,
          activationDate: state.transmitterStartDate,
          needsExpiryRead: state.transmitterExpiryInDays === null,
          sensorLifeDays,
          ble,
          clock: ctx.clock,
          log: ctx.log,
          delegate,
          timing: options.timing,
          onLinkEnded: heartbeat.emit,
          randomToken: options.randomToken,
        });
      }
      transmitter.resumeScanning();
    },
    async stop() {
      await transmitter?.stopScanning();
      await persistChain;
    },
    async readings(since) {
      return buffer.since(since);
    },
    onHeartbeat: heartbeat.on,
    sensorInfo() {
      // The sensor session starts `sensorStartOffset` seconds after the transmitter was activated.
      if (state.transmitterStartDate === null || state.sensorStartOffset === null || state.sensorStartOffset === NO_ACTIVE_SESSION_START_TIME) return null;
      const startedAt = state.transmitterStartDate + state.sensorStartOffset * 1000;
      return { startedAt, expiresAt: startedAt + sensorLifeDays() * 24 * 3_600_000, warmupEndsAt: startedAt + G6_WARMUP_MS };
    },
  };
}

export const dexcomG6Cgm = defineCgm<DexcomG6Settings>({
  meta: META,
  settings: [
    {
      title: 'Transmitter',
      fields: [
        { kind: 'text', key: 'transmitterId', label: 'Transmitter ID', placeholder: '8G1234', help: 'The 6-character ID printed on the transmitter.' },
        {
          kind: 'boolean',
          key: 'passiveMode',
          label: 'Follow the Dexcom app',
          help: 'Listen to the connection the Dexcom app makes (recommended). Turn off only if no other app is paired with the transmitter.',
        },
      ],
    },
  ],
  defaultSettings: { transmitterId: '', passiveMode: true },
  create: (settings, ctx) => createDexcomG6Source(settings, ctx),
});
