/**
 * Buddy CGM plugins wrapping the TypeScript port of loopandlearn/LibreTransmitter (MIT,
 * (c) the LibreTransmitter authors). Plays the role of `LibreTransmitter/LibreTransmitterManagerV3.swift`
 * minus LoopKit, HealthKit, notifications and UI.
 *
 * - `libre-2-direct`: Libre 2 (EU) sensor over BLE after NFC pairing (`pairSensor`).
 * - `libre-transmitter`: Libre 1 / Libre 2 via a MiaoMiao or Bubble bridge.
 */
import { defineCgm, hex, fromHex, type CgmSource, type DeviceContext, type DeviceMeta, type GlucoseReading, type SecretStore } from '@buddy/core';
import { Libre2DirectTransmitter, LIBRE2_NOTIFY, LIBRE2_SERVICE, LIBRE2_WRITE, matchesLibre2Advertisement, nextUnlock, type Libre2Sensor } from './libre2-direct';
import { LibreErrorDescription, LibreReadingProcessor, type LibreUpdateResult } from './processor';
import { LibreBleSession, type SessionProtocol } from './session';
import { LIBRE_SECRET_KEYS, calibrationStore, loadCalibrationMapping, loadLibre2Sensor, saveLibre2Sensor } from './storage';
import { BubbleTransmitter, MiaoMiaoTransmitter, NORDIC_UART_NOTIFY, NORDIC_UART_SERVICE, NORDIC_UART_WRITE, type LibreTransmitterProxy } from './transmitters';

export const LIBRE2_DIRECT_ID = 'libre-2-direct';
export const LIBRE_TRANSMITTER_ID = 'libre-transmitter';

const MAX_BUFFER_AGE_MS = 24 * 60 * 60_000;
const DELAYED_RECONNECT_MS = 7_000;

/** In-memory reading buffer shared by both plugins (deduplicated by timestamp). */
export class ReadingBuffer {
  private readonly byDate = new Map<number, GlucoseReading>();
  add(readings: readonly GlucoseReading[]): void {
    for (const r of readings) this.byDate.set(r.date, r);
    const newest = Math.max(...this.byDate.keys());
    for (const d of [...this.byDate.keys()]) if (d < newest - MAX_BUFFER_AGE_MS) this.byDate.delete(d);
  }
  since(since: number): GlucoseReading[] {
    return [...this.byDate.values()].filter((r) => r.date > since).sort((a, b) => a.date - b.date);
  }
}

function requireCapability<T>(value: T | undefined, what: string, id: string): T {
  if (value === undefined) throw new Error(`${id} needs ${what}, which is not available on this device`);
  return value;
}

function report(ctx: DeviceContext, buffer: ReadingBuffer, result: LibreUpdateResult): void {
  if (result.kind === 'newData') buffer.add(result.readings);
  else if (result.kind === 'error') ctx.log.warn(`Libre: ${LibreErrorDescription[result.error]}`);
}

/** Exposed so tests can wait for queued notifications. */
export interface LibreCgmSource extends CgmSource {
  idle(): Promise<void>;
}

// ── Libre 2 direct ────────────────────────────────────────────────────────────

export interface Libre2DirectSettings {
  readonly [key: string]: string | number | boolean;
}

const LIBRE2_META: DeviceMeta = {
  id: LIBRE2_DIRECT_ID,
  name: 'Libre 2 (direct)',
  manufacturer: 'Abbott',
  description: 'Freestyle Libre 2 (EU) read directly over Bluetooth. Pair the warmed-up sensor via NFC first. Libre 3 is not supported.',
  transport: 'ble',
  maturity: 'experimental',
};

function libre2Protocol(
  ctx: DeviceContext,
  secrets: SecretStore,
  buffer: ReadingBuffer,
  processor: LibreReadingProcessor,
): { protocol: SessionProtocol; loadSensor: () => Promise<Libre2Sensor> } {
  const transmitter = new Libre2DirectTransmitter();
  const calibration = calibrationStore(secrets, LIBRE_SECRET_KEYS.libre2Calibration);
  let sensor: Libre2Sensor | null = null;
  const loadSensor = async (): Promise<Libre2Sensor> => {
    sensor = await loadLibre2Sensor(secrets);
    if (!sensor) throw new Error('No Libre 2 sensor paired. Scan the sensor with NFC first.');
    return sensor;
  };
  const protocol: SessionProtocol = {
    service: LIBRE2_SERVICE,
    writeCharacteristic: LIBRE2_WRITE,
    notifyCharacteristic: LIBRE2_NOTIFY,
    reconnectDelayMs: () => 0,
    matches: (ad) => sensor !== null && matchesLibre2Advertisement(ad, sensor),
    reset: () => transmitter.reset(),
    async afterSubscribe() {
      const { sensor: next, payload } = nextUnlock(await loadSensor());
      await saveLibre2Sensor(secrets, next);
      sensor = next;
      return [payload];
    },
    async onNotify(value) {
      const out = transmitter.onNotify(value, sensor, ctx.clock.now());
      if (out.kind === 'error') ctx.log.warn(`Libre 2: packet rejected (${out.error})`);
      if (out.kind !== 'update' || !sensor) return [];
      const result = processor.sensorDidUpdate(out.response, hex(sensor.uid), await calibration.get(), await loadCalibrationMapping(secrets));
      report(ctx, buffer, result);
      return [];
    },
  };
  return { protocol, loadSensor };
}

export const libre2DirectCgm = defineCgm<Libre2DirectSettings>({
  meta: LIBRE2_META,
  settings: [],
  defaultSettings: {},
  create(_settings, ctx): LibreCgmSource {
    const ble = requireCapability(ctx.ble, 'Bluetooth (ctx.ble)', LIBRE2_DIRECT_ID);
    const secrets = requireCapability(ctx.secrets, 'a secret store (ctx.secrets)', LIBRE2_DIRECT_ID);
    const buffer = new ReadingBuffer();
    const processor = new LibreReadingProcessor({ source: LIBRE2_DIRECT_ID, clock: ctx.clock });
    const { protocol, loadSensor } = libre2Protocol(ctx, secrets, buffer, processor);
    const session = new LibreBleSession({
      ble,
      clock: ctx.clock,
      log: ctx.log,
      protocol,
      loadDeviceId: () => secrets.get(LIBRE_SECRET_KEYS.libre2DeviceId),
      saveDeviceId: (id) => secrets.set(LIBRE_SECRET_KEYS.libre2DeviceId, id),
    });
    return {
      meta: LIBRE2_META,
      async start() {
        await loadSensor(); // advertisement matching needs the paired sensor
        await session.start();
      },
      stop: () => session.stop(),
      readings: async (since) => buffer.since(since),
      idle: () => session.idle(),
    };
  },
});

// ── MiaoMiao / Bubble ─────────────────────────────────────────────────────────

export interface LibreTransmitterSettings {
  readonly [key: string]: string | number | boolean;
  backfillFromHistory: boolean;
}

const TRANSMITTER_META: DeviceMeta = {
  id: LIBRE_TRANSMITTER_ID,
  name: 'Libre via MiaoMiao / Bubble',
  manufacturer: 'Tomato / Bubbledevteam',
  description: 'Freestyle Libre 1 or Libre 2 (EU) read through a MiaoMiao or Bubble NFC-to-Bluetooth bridge.',
  transport: 'ble',
  maturity: 'experimental',
};

interface StoredTransmitter {
  id: string;
  kind: 'miaomiao' | 'bubble';
  manufacturerData: string | null;
}

async function loadTransmitter(secrets: SecretStore): Promise<StoredTransmitter | null> {
  const raw = await secrets.get(LIBRE_SECRET_KEYS.transmitterDeviceId);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredTransmitter>;
    if (typeof v.id !== 'string' || (v.kind !== 'miaomiao' && v.kind !== 'bubble')) return null;
    return { id: v.id, kind: v.kind, manufacturerData: typeof v.manufacturerData === 'string' ? v.manufacturerData : null };
  } catch {
    return null;
  }
}

const makeProxy = (t: StoredTransmitter): LibreTransmitterProxy =>
  t.kind === 'bubble' ? new BubbleTransmitter(t.manufacturerData ? fromHex(t.manufacturerData) : null) : new MiaoMiaoTransmitter();

export const libreTransmitterCgm = defineCgm<LibreTransmitterSettings>({
  meta: TRANSMITTER_META,
  settings: [
    {
      title: 'Libre transmitter',
      fields: [{ kind: 'boolean', key: 'backfillFromHistory', label: 'Backfill from 15-minute sensor history' }],
    },
  ],
  defaultSettings: { backfillFromHistory: true },
  create(settings, ctx): LibreCgmSource {
    const ble = requireCapability(ctx.ble, 'Bluetooth (ctx.ble)', LIBRE_TRANSMITTER_ID);
    const secrets = requireCapability(ctx.secrets, 'a secret store (ctx.secrets)', LIBRE_TRANSMITTER_ID);
    const buffer = new ReadingBuffer();
    const processor = new LibreReadingProcessor({ source: LIBRE_TRANSMITTER_ID, clock: ctx.clock, backfillFromHistory: settings.backfillFromHistory });
    const calibration = calibrationStore(secrets, LIBRE_SECRET_KEYS.transmitterCalibration);
    let proxy: LibreTransmitterProxy | null = null;
    let selected: StoredTransmitter | null = null;

    const protocol: SessionProtocol = {
      service: NORDIC_UART_SERVICE,
      writeCharacteristic: NORDIC_UART_WRITE,
      notifyCharacteristic: NORDIC_UART_NOTIFY,
      reconnectDelayMs: () => DELAYED_RECONNECT_MS,
      matches: (ad) => MiaoMiaoTransmitter.canSupportPeripheral(ad.name) || BubbleTransmitter.canSupportPeripheral(ad.name),
      async onSelected(ad) {
        selected = {
          id: ad.id,
          kind: BubbleTransmitter.canSupportPeripheral(ad.name) ? 'bubble' : 'miaomiao',
          manufacturerData: ad.manufacturerData ? hex(ad.manufacturerData) : null,
        };
        proxy = makeProxy(selected);
        await secrets.set(LIBRE_SECRET_KEYS.transmitterDeviceId, JSON.stringify(selected));
      },
      reset: () => proxy?.reset(),
      async afterSubscribe() {
        return proxy ? proxy.requestData() : [];
      },
      async onNotify(value) {
        if (!proxy) return [];
        const out = proxy.onNotify(value, ctx.clock.now());
        if (out.event === 'noSensor') ctx.log.warn('Libre transmitter: no sensor detected');
        if (out.event === 'newSensor') ctx.log.info('Libre transmitter: new sensor detected');
        if (out.packet) report(ctx, buffer, await processor.transmitterDidUpdate(out.packet.sensorData, out.packet.metadata, calibration));
        return out.writes;
      },
    };

    const session = new LibreBleSession({
      ble,
      clock: ctx.clock,
      log: ctx.log,
      protocol,
      loadDeviceId: async () => {
        selected ??= await loadTransmitter(secrets);
        if (selected) proxy ??= makeProxy(selected);
        return selected?.id ?? null;
      },
      saveDeviceId: async () => {},
    });
    return {
      meta: TRANSMITTER_META,
      start: () => session.start(),
      stop: () => session.stop(),
      readings: async (since) => buffer.since(since),
      idle: () => session.idle(),
    };
  },
});
