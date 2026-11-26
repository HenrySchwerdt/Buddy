/**
 * Buddy CGM plugin `libre-3-direct`: FreeStyle Libre 3 / 3+ read directly over Bluetooth after NFC
 * pairing (`pairLibre3Sensor`). Plays the role of LibreLoop `LibreLoopCGMManager` minus Loop, HealthKit,
 * notifications and UI. Protocol port of RoundWhiteDiscKit and LibreLoop (MIT, (c) the
 * RoundWhiteDiscKit and LibreLoop authors).
 *
 * Independent of Abbott and not endorsed by Abbott. FreeStyle Libre is a trademark of Abbott.
 */
import { defineCgm, type CgmSource, type DeviceContext, type DeviceMeta } from '@buddy/core';
import { LIBRE3_ID } from './constants';
import { Libre3Engine, type Libre3Phase } from './engine';
import { installAppIdentities } from './identity';
import { SensorLifecycle, type LifecyclePhase, type SensorAttention } from './lifecycle';
import { ReadingPipeline } from './pipeline';
import { secureRandom, type RandomSource } from './random';
import { Libre3ReadingBuffer } from './readings';
import { SensorStateHolder } from './state-holder';
import { loadSensorState } from './storage';
import { DEFAULT_TIMING, type Libre3Timing } from './timing';
import type { Bytes } from '@buddy/core';

export interface Libre3DirectSettings {
  readonly [key: string]: string | number | boolean;
  minuteByMinute: boolean;
  useNonActionable: boolean;
  appCredential: string;
}

export const LIBRE3_META: DeviceMeta = {
  id: LIBRE3_ID,
  name: 'FreeStyle Libre 3 (direct)',
  manufacturer: 'Abbott',
  description:
    'FreeStyle Libre 3 / 3+ read directly over Bluetooth after NFC pairing, using the community-reverse-engineered protocol of RoundWhiteDiscKit and LibreLoop. ' +
    'Independent of Abbott and not endorsed by Abbott. Experimental, not a medical device. The official app\'s alarms are not active while Buddy talks to the sensor: keep an independent low/high glucose alerting path.',
  transport: 'ble',
  maturity: 'experimental',
};

export interface Libre3Status {
  readonly phase: Libre3Phase;
  /** The sensor keeps refusing the saved authorization: scan it with NFC again. */
  readonly needsRepair: boolean;
  readonly serialNumber: string | null;
  readonly lifecycle: LifecyclePhase | null;
  readonly wearRemainingMinutes: number | null;
  readonly needsReplacement: boolean;
  readonly endedNormally: boolean;
  readonly attention: SensorAttention;
  readonly lastReadingAt: number | null;
  /** Why the latest reading was withheld (warmup, data quality, not actionable ...), if it was. */
  readonly lastIssue: string | null;
}

export interface Libre3CgmSource extends CgmSource {
  status(): Libre3Status;
  /** Resolves once received notifications, reconnects and backfill have settled (tests). */
  idle(): Promise<void>;
  /** Runs one silence-watchdog pass (tests). */
  checkSilence(): Promise<void>;
}

/** Test seams; the plugin uses the defaults. */
export interface Libre3SourceOptions {
  readonly timing?: Partial<Libre3Timing>;
  readonly random?: RandomSource;
  /** Replaces the Abbott patch-signing keys (simulator only). */
  readonly signingKeys?: readonly Bytes[];
}

function require<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${LIBRE3_ID} needs ${what}, which is not available on this device`);
  return value;
}

export function createLibre3Source(settings: Libre3DirectSettings, ctx: DeviceContext, options: Libre3SourceOptions = {}): Libre3CgmSource {
  const ble = require(ctx.ble, 'Bluetooth (ctx.ble)');
  const secrets = require(ctx.secrets, 'a secret store (ctx.secrets)');
  const timing: Libre3Timing = { ...DEFAULT_TIMING, ...options.timing };
  const buffer = new Libre3ReadingBuffer();
  let runtime: { holder: SensorStateHolder; pipeline: ReadingPipeline; engine: Libre3Engine } | null = null;

  const build = async () => {
    const credential = String(settings.appCredential ?? '').trim();
    if (credential !== '') await installAppIdentities(secrets, credential);
    const sensor = await loadSensorState(secrets);
    if (!sensor) throw new Error('No Libre 3 sensor paired. Scan the sensor with NFC first.');
    const holder = new SensorStateHolder(sensor, secrets, ctx.log);
    let engineRef: Libre3Engine | null = null;
    const pipeline = new ReadingPipeline({
      clock: ctx.clock,
      log: ctx.log,
      holder,
      buffer,
      timing,
      settings: { minuteByMinute: settings.minuteByMinute === true, useNonActionable: settings.useNonActionable === true },
      onSensorEnded: () => engineRef?.sensorEnded(),
    });
    const engine = new Libre3Engine({ ble, secrets, clock: ctx.clock, log: ctx.log, holder, pipeline, timing, random: options.random ?? secureRandom, signingKeys: options.signingKeys });
    engineRef = engine;
    return { holder, pipeline, engine };
  };

  return {
    meta: LIBRE3_META,
    async start() {
      runtime ??= await build();
      await runtime.engine.start();
    },
    async stop() {
      await runtime?.engine.stop();
    },
    readings: async (since) => buffer.since(since),
    sensorInfo() {
      const sensor = runtime?.holder.current ?? null;
      const telemetry = runtime?.pipeline.telemetry ?? null;
      if (!sensor || telemetry?.lifeCount == null || telemetry.lastReadingAt == null) return null;
      // Life count is the sensor's age in minutes at the last reading.
      const startedAt = telemetry.lastReadingAt - telemetry.lifeCount * 60_000;
      const wear = sensor.wearDurationMinutes;
      if (wear == null) return null;
      return { startedAt, expiresAt: startedAt + wear * 60_000, warmupEndsAt: startedAt + (sensor.warmupMinutes ?? 60) * 60_000 };
    },
    idle: async () => runtime?.engine.idle(),
    checkSilence: async () => runtime?.engine.checkSilence(),
    status() {
      const sensor = runtime?.holder.current ?? null;
      const telemetry = runtime?.pipeline.telemetry ?? null;
      const lifecycle = sensor && telemetry?.lifeCount != null ? new SensorLifecycle(telemetry.lifeCount, sensor.warmupMinutes ?? 60, sensor.wearDurationMinutes) : null;
      return {
        phase: runtime?.engine.state.phase ?? 'idle',
        needsRepair: runtime?.engine.state.needsRepair ?? false,
        serialNumber: sensor?.serialNumber ?? null,
        lifecycle: lifecycle?.phase ?? null,
        wearRemainingMinutes: lifecycle?.remainingWearMinutes ?? null,
        needsReplacement: sensor?.needsReplacement ?? false,
        endedNormally: sensor?.endedNormally ?? false,
        attention: telemetry?.attention ?? 'none',
        lastReadingAt: telemetry?.lastReadingAt ?? null,
        lastIssue: telemetry?.lastIssue ?? null,
      };
    },
  };
}

export const libre3DirectCgm = defineCgm<Libre3DirectSettings>({
  meta: LIBRE3_META,
  settings: [
    {
      title: 'FreeStyle Libre 3',
      fields: [
        { kind: 'boolean', key: 'minuteByMinute', label: 'Use every minute', help: 'Off: one reading about every 5 minutes (what the algorithms are tuned for).' },
        { kind: 'boolean', key: 'useNonActionable', label: 'Use readings the sensor marks "not actionable"', help: 'Off is safer: such readings are display-only in the Abbott app.' },
        { kind: 'text', key: 'appCredential', label: 'App credential (JSON)', secret: true, help: 'Format 1, P-256 identities. Not shipped with Buddy; paste it once, it is kept in the keychain.' },
      ],
    },
  ],
  defaultSettings: { minuteByMinute: false, useNonActionable: false, appCredential: '' },
  create: (settings, ctx): Libre3CgmSource => createLibre3Source(settings, ctx),
});
