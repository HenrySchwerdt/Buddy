/**
 * Connection and persistence of the MiniMed driver. Port of the session handling of
 * `PumpOps.swift` (`runSession`, `configureDevice`) and the state handling of
 * `MinimedPumpManager.swift` from MinimedKit (migrated from ps2/rileylink_ios, MIT License,
 * (c) LoopKit Authors): the RileyLink is connected and its radio configured for the pump's
 * region, then a `MinimedSession` talks to the pump through it. Status reconciliation lives in
 * `reconcile.ts`.
 *
 * Differences to the Swift original are marked DEVIATION. LoopKit glue, UI, alerts and
 * notifications are not ported (pump alerts are logged).
 */
import type { BleTransport, Clock, DeviceContext, Logger, Millis, SecretStore } from '@buddy/core';
import { RileyLinkDevice } from '../rileylink';
import { MinimedError, errorMessage } from './errors';
import { DEFAULT_FREQUENCY_MHZ, isPumpRegion, type BatteryChemistry, type PumpRegion } from './models';
import { pumpAddress } from './messages/pump-message';
import { configureMinimedRadio } from './radio-config';
import { loadRecord, saveRecord, initialRecord, type MinimedRecord } from './record';
import { pruneLedger, type LedgerState } from './ledger';
import { MinimedSession } from './session';

export type MinimedSettings = {
  /** BLE id of the selected RileyLink (empty until picked in the setup). */
  rileyLinkId: string;
  /** The 6 digit serial number printed on the back of the pump. */
  pumpSerial: string;
  /** RF band of the pump: `NA` (North America) or `WW` (world-wide). */
  pumpRegion: string;
  /** The model number (e.g. 723); the model detected from the pump is what the driver encodes with. */
  pumpModel: string;
};

export interface MinimedDriverOptions {
  /** BLE connect timeout of the RileyLink. */
  readonly connectTimeoutMs?: number;
  /** Local UTC offset in seconds at `at`; the pump keeps local wall-clock time. */
  readonly utcOffsetSeconds?: (at: Millis) => number;
  /** A status older than this is refreshed from the pump. */
  readonly statusFreshMs?: number;
  /** The history is read at least this often. */
  readonly historyEveryMs?: number;
  /** Re-tune the radio after a failure when the last tune is older than this (MinimedKit: 14 min). */
  readonly tuneToleranceMs?: number;
  /** Set the pump's clock when it is more than 20 s off (MinimedKit does). */
  readonly autoSetTime?: boolean;
  readonly batteryChemistry?: BatteryChemistry;
  /** RileyLink command timing (tests shorten the BLE latency allowance). */
  readonly rileyLink?: { readonly bleLatencyMs?: number; readonly versionTimeoutMs?: number };
  /** Pause after every answered message (MinimedKit: 200 ms). */
  readonly responseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_STATUS_FRESH_MS = 60_000;
export const DEFAULT_HISTORY_EVERY_MS = 10 * 60_000;
const DEFAULT_TUNE_TOLERANCE_MS = 14 * 60_000;

/** The radio layer logs nothing below warnings: no addresses, no frames. */
const quietLog = (log: Logger): Logger => ({ info: () => undefined, warn: (m) => log.warn(m), error: (m) => log.error(m) });

export class MinimedCore {
  protected readonly ble: BleTransport;
  protected readonly secrets: SecretStore;
  protected readonly clock: Clock;
  protected readonly log: Logger;
  protected readonly opts: Required<Pick<MinimedDriverOptions, 'connectTimeoutMs' | 'utcOffsetSeconds' | 'statusFreshMs' | 'historyEveryMs' | 'tuneToleranceMs' | 'autoSetTime' | 'batteryChemistry'>> & MinimedDriverOptions;

  protected record: MinimedRecord = initialRecord();
  private loading: Promise<void> | null = null;
  protected device: RileyLinkDevice | null = null;
  protected session: MinimedSession | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    protected readonly settings: MinimedSettings,
    ctx: DeviceContext,
    options: MinimedDriverOptions = {},
  ) {
    if (!ctx.ble) throw new Error('MiniMed needs Bluetooth: DeviceContext.ble is missing');
    if (!ctx.secrets) throw new Error('MiniMed needs secure storage for the pump state: DeviceContext.secrets is missing');
    this.ble = ctx.ble;
    this.secrets = ctx.secrets;
    this.clock = ctx.clock;
    this.log = ctx.log;
    this.opts = {
      ...options,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      utcOffsetSeconds: options.utcOffsetSeconds ?? ((at) => -new Date(at).getTimezoneOffset() * 60),
      statusFreshMs: options.statusFreshMs ?? DEFAULT_STATUS_FRESH_MS,
      historyEveryMs: options.historyEveryMs ?? DEFAULT_HISTORY_EVERY_MS,
      tuneToleranceMs: options.tuneToleranceMs ?? DEFAULT_TUNE_TOLERANCE_MS,
      autoSetTime: options.autoSetTime ?? true,
      batteryChemistry: options.batteryChemistry ?? 'alkaline',
    };
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  /** One command in flight at a time. */
  protected serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  protected now(): Millis {
    return this.clock.now();
  }

  /** The configured serial when it is 6 digits, else null. */
  protected get serial(): string | null {
    const s = this.settings.pumpSerial.trim();
    return /^[0-9]{6}$/.test(s) ? s : null;
  }

  protected get region(): PumpRegion {
    return isPumpRegion(this.settings.pumpRegion) ? this.settings.pumpRegion : 'NA';
  }

  /** Why the settings cannot work, or null. */
  protected get configurationProblem(): string | null {
    if (this.serial === null) return 'The pump serial number must be 6 digits';
    if (!isPumpRegion(this.settings.pumpRegion)) return 'Pick the pump region (North America or world-wide)';
    if (!this.settings.rileyLinkId.trim()) return 'No RileyLink selected. Pick one in the pump setup.';
    return null;
  }

  protected async load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const serial = this.serial;
        this.record = serial === null ? initialRecord() : await loadRecord(this.secrets, serial);
      })();
      this.loading.catch(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  protected update(patch: Partial<Omit<MinimedRecord, 'version'>>): void {
    this.record = { ...this.record, ...patch };
  }

  protected updateLedger(fn: (l: LedgerState) => LedgerState): void {
    this.record = { ...this.record, ledger: fn(this.record.ledger) };
  }

  /** Writes the record; a failed write is logged, not thrown. */
  protected async persist(): Promise<void> {
    try {
      await this.persistStrict();
    } catch (e) {
      this.log.error(`MiniMed: failed to persist the pump record: ${errorMessage(e)}`);
    }
  }

  /** Like {@link persist}, but rejects when the write failed (used where the record must be durable before acting). */
  protected persistStrict(): Promise<void> {
    const serial = this.serial;
    if (serial === null) return Promise.resolve();
    const snapshot: MinimedRecord = { ...this.record, ledger: pruneLedger(this.record.ledger, this.now()) };
    const run = this.saving.then(() => saveRecord(this.secrets, serial, snapshot));
    this.saving = run.catch(() => undefined);
    return run;
  }

  protected get isConnected(): boolean {
    return this.session !== null && this.device?.isConnected === true;
  }

  // ── radio ──────────────────────────────────────────────────────────────────

  /** Closes the RileyLink and forgets the session; the next command reconnects. */
  protected dropConnection(): void {
    const d = this.device;
    this.device = null;
    this.session = null;
    if (d) void d.disconnect().catch(() => undefined);
  }

  /** Connects the selected RileyLink and configures its radio for the pump's band (`configureDevice`). */
  protected async openRadio(): Promise<RileyLinkDevice> {
    if (this.device?.isConnected) return this.device;
    this.dropConnection();
    const problem = this.configurationProblem;
    if (problem) throw new MinimedError('invalid', problem);
    let device: RileyLinkDevice | null = null;
    try {
      device = await RileyLinkDevice.connect(this.ble, this.settings.rileyLinkId.trim(), { log: quietLog(this.log), connectTimeoutMs: this.opts.connectTimeoutMs, ...this.opts.rileyLink });
      await configureMinimedRadio(device, this.region, this.record.frequencyMhz ?? DEFAULT_FREQUENCY_MHZ[this.region]);
    } catch (e) {
      await device?.disconnect().catch(() => undefined);
      throw new MinimedError('device', `RileyLink: ${errorMessage(e)}`);
    }
    this.device = device;
    return device;
  }

  protected makeSession(device: RileyLinkDevice): MinimedSession {
    const address = pumpAddress(this.serial ?? '');
    if (!address) throw new MinimedError('invalid', 'The pump serial number must be 6 digits');
    return new MinimedSession({
      radio: device,
      address,
      clock: this.clock,
      log: quietLog(this.log),
      model: this.record.pumpModel,
      responseDelayMs: this.opts.responseDelayMs,
      sleep: this.opts.sleep,
    });
  }
}
