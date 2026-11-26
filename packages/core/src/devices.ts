import type { SettingsSection, SettingsValues } from './settings-schema';
import type { BleTransport, NfcTransport, SecretStore } from './transport';
import type { CarbEntry, GlucoseReading, InsulinDose, Millis, PumpState } from './types';

export interface Clock {
  now(): Millis;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export interface DeviceContext {
  readonly clock: Clock;
  readonly log: Logger;
  /** Platform fetch (injected so drivers stay testable). */
  readonly fetch: typeof fetch;
  /** Bluetooth LE, present on devices (absent in pure simulations). */
  readonly ble?: BleTransport;
  /** NFC (Libre activation / pairing). */
  readonly nfc?: NfcTransport;
  /** Persistent, keychain-backed storage for pairing keys and device identity. */
  readonly secrets?: SecretStore;
}

export type Transport = 'simulated' | 'ble' | 'network' | 'native-module';

export interface DeviceMeta {
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  readonly description: string;
  readonly transport: Transport;
  /** Experimental drivers are only offered in developer mode. */
  readonly maturity: 'stable' | 'experimental' | 'simulator';
  /** Read-only "pumps" (shadow mode) never accept commands; the loop stays open. */
  readonly readOnly?: boolean;
}

export type CommandResult = { readonly ok: true; readonly dose?: InsulinDose } | { readonly ok: false; readonly error: string };

/**
 * A pump driver. Every command must only resolve `ok: true` once the pump has confirmed it;
 * `history()` must return only *delivered* insulin. IOB is computed from history, so a
 * driver that reports unconfirmed doses would corrupt dosing.
 */
export interface PumpDriver {
  readonly meta: DeviceMeta;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): Promise<PumpState>;
  setTempBasal(rate: number, durationMin: number): Promise<CommandResult>;
  cancelTempBasal(): Promise<CommandResult>;
  bolus(units: number, options: { readonly automatic: boolean }): Promise<CommandResult>;
  cancelBolus(): Promise<CommandResult>;
  suspend(): Promise<CommandResult>;
  resume(): Promise<CommandResult>;
  /** Delivered doses with `date >= since`. */
  history(since: Millis): Promise<InsulinDose[]>;
  /**
   * Optional Bluetooth heartbeat: fires when the pump link showed activity (a connect, a notification or a
   * disconnect), which wakes a backgrounded iOS app. Mirrors Trio's `pumpManagerMustProvideBLEHeartbeat`: the
   * runtime only uses it when the CGM provides no heartbeat. A listener must never dose; it only requests a loop run.
   */
  onHeartbeat?(listener: () => void): () => void;
  /** Read-only sources (e.g. following another loop via Nightscout) may also supply carbs. */
  carbHistory?(since: Millis): Promise<CarbEntry[]>;
  /** What another loop (e.g. Trio) decided, for side-by-side comparison in shadow mode. */
  referenceDecision?(at: Millis): Promise<ReferenceDecision | null>;
}

/** A decision made by an external loop, as reported by it (e.g. Trio via Nightscout devicestatus). */
export interface ReferenceDecision {
  readonly source: string;
  readonly date: Millis;
  readonly tempBasal?: { readonly rate: number; readonly durationMin: number } | null;
  readonly autoBolus?: number;
  readonly eventualGlucose?: number;
  readonly iob?: number;
  readonly cob?: number;
  readonly reason?: string;
  readonly predictions?: { readonly iob?: readonly number[]; readonly zt?: readonly number[]; readonly cob?: readonly number[]; readonly uam?: readonly number[] };
}

/** Where the current CGM sensor is in its life; read-only, from state the driver already has. */
export interface CgmSensorInfo {
  /** When the sensor session started (epoch ms). */
  readonly startedAt: Millis;
  /** When the session ends (epoch ms). */
  readonly expiresAt: Millis;
  /** When warm-up ends and readings start, while the sensor is still warming up. */
  readonly warmupEndsAt?: Millis | null;
}

export interface CgmSource {
  readonly meta: DeviceMeta;
  /** Current sensor session, or null when the driver does not know one (yet). */
  sensorInfo?(): CgmSensorInfo | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Readings with `date > since`, any order. */
  readings(since: Millis): Promise<GlucoseReading[]>;
  /**
   * Optional Bluetooth heartbeat (Trio `cgmProvidesBLEHeartbeat`): fires after new readings arrived and when a
   * link ended, i.e. whenever the sensor woke the app. The runtime decides whether a loop run is due. Present only
   * on sources that keep a system-managed BLE scan or connect armed, so a backgrounded iOS app is woken by them.
   */
  onHeartbeat?(listener: () => void): () => void;
}

/** A plugin that knows how to build a device from user settings. */
export interface DevicePlugin<T, S extends SettingsValues = SettingsValues> {
  readonly meta: DeviceMeta;
  readonly settings: readonly SettingsSection[];
  readonly defaultSettings: S;
  create(settings: S, ctx: DeviceContext): T;
}

export type PumpPlugin<S extends SettingsValues = SettingsValues> = DevicePlugin<PumpDriver, S>;
export type CgmPlugin<S extends SettingsValues = SettingsValues> = DevicePlugin<CgmSource, S>;

export const definePump = <S extends SettingsValues>(p: PumpPlugin<S>): PumpPlugin<S> => p;
export const defineCgm = <S extends SettingsValues>(p: CgmPlugin<S>): CgmPlugin<S> => p;
