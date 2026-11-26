/**
 * Connection and persistence of the Omnipod Eros driver. Port of the session handling of
 * `Eros/ErosPodComms.swift` (`erosRunSession`, `configureDevice`) and `PumpManager/PodComms.swift`
 * from OmnipodKit (MIT License, (c) LoopKit Authors): the RileyLink is connected and its radio
 * configured for Eros, then a transport talks to the pod through it. Status reconciliation lives
 * in `reconcile.ts`.
 *
 * Differences to the Swift original are marked DEVIATION. LoopKit glue, UI, alerts and
 * notifications are not ported (pod alerts are logged).
 */
import type { BleTransport, Clock, DeviceContext, Logger, Millis, SecretStore } from '@buddy/core';
import { SetupProgress, setupIsPaired } from '../common';
import { configureErosRadio, ErosMessageTransport, type ErosTiming } from '../eros';
import { RileyLinkDevice } from '../../rileylink';
import { pruneLedger, type LedgerState } from '../dash/dose-ledger';
import { ErosPodComms } from './comms';
import { errorMessage, OmnipodError } from './errors';
import { loadErosRecord, saveErosRecord, initialErosRecord, type ErosPodRecord } from './record';

export type OmnipodErosSettings = {
  /** BLE id of the selected RileyLink (empty until picked in the setup). */
  rileyLinkId: string;
  /** Low reservoir alert of the pod in units (0 = off). */
  lowReservoirUnits: number;
  /** Hours before the 72 h nominal pod life at which the pod reminds (0 = off). */
  expirationReminderHours: number;
  /** Alerts without sound (the pod still raises them). */
  silentAlerts: boolean;
};

export interface ErosDriverOptions {
  /** BLE connect timeout of the RileyLink. */
  readonly connectTimeoutMs?: number;
  readonly scanTimeoutMs?: number;
  /** Local UTC offset in seconds at `at`; used for the basal schedule and the pod clock. */
  readonly utcOffsetSeconds?: (at: Millis) => number;
  /** A status older than this is refreshed from the pod. */
  readonly statusFreshMs?: number;
  /** Clock for the radio timeouts of the transport (default: the context clock). Tests drive it with the simulated air. */
  readonly transportClock?: Clock;
  readonly transportTiming?: Partial<ErosTiming>;
  /** RileyLink command timing (tests shorten the BLE latency allowance). */
  readonly rileyLink?: { readonly bleLatencyMs?: number; readonly versionTimeoutMs?: number };
  /** Uniform unsigned 32-bit random numbers for the pod address (default: platform CSPRNG). */
  readonly random32?: () => number;
}

export const DEFAULT_STATUS_FRESH_MS = 30_000;

/** The transport logs full messages (they contain nonces) at info level: only warnings and errors pass. */
const quietLog = (log: Logger): Logger => ({ info: () => undefined, warn: (m) => log.warn(m), error: (m) => log.error(m) });

export class OmnipodErosCore {
  protected readonly ble: BleTransport;
  protected readonly secrets: SecretStore;
  protected readonly clock: Clock;
  protected readonly log: Logger;
  protected readonly opts: Required<Pick<ErosDriverOptions, 'connectTimeoutMs' | 'scanTimeoutMs' | 'utcOffsetSeconds' | 'statusFreshMs'>> & ErosDriverOptions;

  protected record: ErosPodRecord = initialErosRecord();
  private loading: Promise<void> | null = null;
  protected device: RileyLinkDevice | null = null;
  protected comms: ErosPodComms | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    protected readonly settings: OmnipodErosSettings,
    ctx: DeviceContext,
    options: ErosDriverOptions = {},
  ) {
    if (!ctx.ble) throw new Error('Omnipod Eros needs Bluetooth: DeviceContext.ble is missing');
    if (!ctx.secrets) throw new Error('Omnipod Eros needs secure storage for the pod state: DeviceContext.secrets is missing');
    this.ble = ctx.ble;
    this.secrets = ctx.secrets;
    this.clock = ctx.clock;
    this.log = ctx.log;
    this.opts = {
      ...options,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      scanTimeoutMs: options.scanTimeoutMs ?? 8_000,
      utcOffsetSeconds: options.utcOffsetSeconds ?? ((at) => -new Date(at).getTimezoneOffset() * 60),
      statusFreshMs: options.statusFreshMs ?? DEFAULT_STATUS_FRESH_MS,
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

  protected async load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        this.record = await loadErosRecord(this.secrets);
      })();
      this.loading.catch(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  protected update(patch: Partial<Omit<ErosPodRecord, 'version'>>): void {
    this.record = { ...this.record, ...patch };
  }

  protected updateLedger(fn: (l: LedgerState) => LedgerState): void {
    this.record = { ...this.record, ledger: fn(this.record.ledger) };
  }

  /** Writes the record to the secret store; writes are queued in order. A failed write is logged, not thrown. */
  protected async persist(): Promise<void> {
    try {
      await this.persistStrict();
    } catch (e) {
      this.log.error(`Omnipod Eros: failed to persist the pod record: ${errorMessage(e)}`);
    }
  }

  /** Like {@link persist}, but rejects when the write failed (used where the record must be durable before acting). */
  protected persistStrict(): Promise<void> {
    const snapshot: ErosPodRecord = { ...this.record, ledger: pruneLedger(this.record.ledger, this.now()) };
    const run = this.saving.then(() => saveErosRecord(this.secrets, snapshot));
    this.saving = run.catch(() => undefined);
    return run;
  }

  protected get isConnected(): boolean {
    return this.comms !== null && this.device?.isConnected === true;
  }

  protected get setupComplete(): boolean {
    return this.record.setupProgress === SetupProgress.completed;
  }

  /** An address was assigned and the pod finished pairing (the radio address is the record's `podId`). */
  protected get hasPairedPod(): boolean {
    return this.record.podId !== 0 && setupIsPaired(this.record.setupProgress);
  }

  protected scheduleOffsetSeconds(at: Millis): number {
    const local = Math.floor(at / 1000) + this.opts.utcOffsetSeconds(at);
    return ((local % 86400) + 86400) % 86400;
  }

  // ── radio ──────────────────────────────────────────────────────────────────

  /** Closes the RileyLink and forgets the session; the next command reconnects. */
  protected dropConnection(): void {
    const d = this.device;
    this.device = null;
    this.comms = null;
    if (d) void d.disconnect().catch(() => undefined);
  }

  /** Connects the selected RileyLink and configures its radio for Eros pods (`configureDevice`). */
  protected async openRadio(): Promise<RileyLinkDevice> {
    if (this.device?.isConnected) return this.device;
    this.dropConnection();
    const id = this.settings.rileyLinkId.trim();
    if (!id) throw new OmnipodError('invalid', 'No RileyLink selected. Pick one in the pump setup.');
    let device: RileyLinkDevice | null = null;
    try {
      device = await RileyLinkDevice.connect(this.ble, id, { log: quietLog(this.log), connectTimeoutMs: this.opts.connectTimeoutMs, ...this.opts.rileyLink });
      await configureErosRadio(device);
    } catch (e) {
      await device?.disconnect().catch(() => undefined);
      throw new OmnipodError('notConnected', `RileyLink: ${errorMessage(e)}`);
    }
    this.device = device;
    return device;
  }

  /** A transport on the open RileyLink; `address` is the pod's (or the pairing) address. Counters are kept in the record. */
  protected makeTransport(device: RileyLinkDevice, address: number, ackAddress?: number): ErosMessageTransport {
    return new ErosMessageTransport({
      radio: device,
      address,
      ackAddress,
      state: { packetNumber: this.record.packetNumber, messageNumber: this.record.transport.messageNumber },
      clock: this.opts.transportClock ?? this.clock,
      log: quietLog(this.log),
      timing: this.opts.transportTiming,
      onStateChange: (s) => this.update({ packetNumber: s.packetNumber, transport: { ...this.record.transport, messageNumber: s.messageNumber } }),
    });
  }

  protected makeComms(device: RileyLinkDevice): ErosPodComms {
    const r = this.record;
    return new ErosPodComms(this.makeTransport(device, r.podId), r.podId, { get: () => this.record.nonce, set: (nonce) => this.update({ nonce }) }, { lot: r.lot, tid: r.tid });
  }
}
