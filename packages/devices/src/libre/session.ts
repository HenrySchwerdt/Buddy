/**
 * BLE connection handling for the Libre drivers. Condensed TypeScript port of the connection
 * logic in `Bluetooth/Transmitter/LibreTransmitterProxyManager.swift` from
 * loopandlearn/LibreTransmitter (MIT, (c) the LibreTransmitter authors): scan for a matching
 * peripheral, remember its identifier, enable notifications, hand writes/notifications to the
 * protocol, reconnect after disconnects (7 s delay for MiaoMiao/Bubble, immediate for Libre 2)
 * and reset the receive buffer when a session goes quiet for more than 6 s.
 *
 * Reconnecting has no JS timer between the disconnect and the next armed operation, so a backgrounded iOS app
 * is woken for it: an immediate reconnect is a pending connect (no timeout) to the known peripheral, and a
 * delayed one is a service-filtered scan (no timeout) that ignores advertisements until the delay has passed.
 * Only the retry after a hard error still waits on a timer.
 */
import type { BleAdvertisement, BleConnection, BleTransport, Bytes, Clock, Logger } from '@buddy/core';
import { NotBefore, scanFirst } from '../ble-rearm';

export interface SessionProtocol {
  readonly service: string;
  readonly writeCharacteristic: string;
  readonly notifyCharacteristic: string;
  /** Delay before reconnecting after a disconnect. */
  reconnectDelayMs(): number;
  /** Picks the peripheral to connect to during a scan. */
  matches(ad: BleAdvertisement): boolean;
  /** Called with the chosen advertisement (before connecting). */
  onSelected?(ad: BleAdvertisement): Promise<void>;
  /** Called after notifications are enabled; returns commands to write (with response). */
  afterSubscribe(): Promise<Bytes[]>;
  /** Handles one notification; returns commands to write. */
  onNotify(value: Bytes): Promise<Bytes[]>;
  /** Clears partially received messages. */
  reset(): void;
}

export interface SessionOptions {
  readonly ble: BleTransport;
  readonly clock: Clock;
  readonly log: Logger;
  readonly protocol: SessionProtocol;
  readonly loadDeviceId: () => Promise<string | null>;
  readonly saveDeviceId: (id: string) => Promise<void>;
  readonly scanTimeoutMs?: number;
  /** Wait before trying again after a reconnect that failed with an error (not after a normal disconnect). */
  readonly retryDelayMs?: number;
  /** A link ended: the app was just woken by the sensor or transmitter. Feeds the CGM heartbeat. */
  readonly onLinkEnded?: () => void;
}

const QUIET_RESET_MS = 6_000;
const DEFAULT_SCAN_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;

export class LibreBleSession {
  private conn: BleConnection | null = null;
  private cleanups: (() => void)[] = [];
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly gate: NotBefore;
  /** The re-arm in flight (pending connect or gated scan), so a second disconnect cannot start another. */
  private arming: Promise<void> | null = null;
  private errorValue: string | null = null;
  /** Failed re-arms retried at once in a row; after a few the retry goes through a timer. */
  private immediateRetries = 0;
  /** The peripheral a pending connect is waiting for, to cancel it on `stop()`. */
  private pendingId: string | null = null;
  private lastNotify: number | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: SessionOptions) {
    this.gate = new NotBefore(o.clock);
  }

  get connected(): boolean {
    return this.conn !== null;
  }

  /**
   * Finds (or reuses) the peripheral and connects. Rejects only when Bluetooth is unavailable. A first connection
   * that fails does not leave Bluetooth unarmed: the error is kept in `lastError` (for the UI) and a pending
   * connect (or, for a peripheral not yet known, a scan without timeout) is armed.
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    const state = await this.o.ble.state();
    if (state !== 'poweredOn') throw new Error(`Bluetooth is not available (${state})`);
    this.stopped = false;
    this.gate.clear();
    this.lastError = null;
    try {
      await this.connectOnce();
    } catch (e) {
      this.lastError = (e as Error).message;
      this.o.log.warn(`Libre: first connect failed (${this.lastError}); armed a pending connect`);
      this.rearm();
    }
  }

  /** The newest connection error while no link is up (a pending connect is armed meanwhile), or null. */
  get lastError(): string | null {
    return this.errorValue;
  }

  private set lastError(value: string | null) {
    this.errorValue = value;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.o.ble.stopScan();
    if (this.pendingId) this.o.ble.cancelConnect?.(this.pendingId);
    this.pendingId = null;
    const conn = this.conn;
    this.teardown();
    if (conn) await conn.disconnect().catch(() => {});
  }

  private teardown(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.conn = null;
    this.o.protocol.reset();
  }

  private async findDevice(): Promise<string> {
    const known = await this.o.loadDeviceId();
    if (known) return known;
    const ad = await scanFirst(this.o.ble, { services: [this.o.protocol.service], timeoutMs: this.o.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS }, (candidate) => this.o.protocol.matches(candidate));
    if (!ad) throw new Error('No matching Libre sensor or transmitter found nearby');
    await this.o.protocol.onSelected?.(ad);
    await this.o.saveDeviceId(ad.id);
    return ad.id;
  }

  private async connectOnce(): Promise<void> {
    const id = await this.findDevice();
    if (this.stopped) return;
    await this.attach(id, await this.o.ble.connect(id, { timeoutMs: 30_000 }));
  }

  /** Takes over an established link: subscribes, hands the protocol its first commands. */
  private async attach(id: string, conn: BleConnection): Promise<void> {
    if (this.stopped) {
      await conn.disconnect().catch(() => {});
      return;
    }
    this.conn = conn;
    this.o.protocol.reset();
    this.cleanups.push(conn.onDisconnect((err) => this.onDisconnect(err)));
    const p = this.o.protocol;
    try {
      this.cleanups.push(await conn.subscribe(p.service, p.notifyCharacteristic, (data) => this.enqueue(() => this.handleNotify(data))));
      await this.write(await p.afterSubscribe());
    } catch (e) {
      this.teardown();
      await conn.disconnect().catch(() => {});
      throw e;
    }
    this.errorValue = null;
    this.immediateRetries = 0;
    this.o.log.info(`Libre: connected to ${id}`);
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((e: unknown) => this.o.log.error(`Libre: ${(e as Error).message}`));
  }

  /** Resolves once every notification received so far has been processed (for tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async handleNotify(data: Bytes): Promise<void> {
    const now = this.o.clock.now();
    if (this.lastNotify !== null && now > this.lastNotify + QUIET_RESET_MS) this.o.protocol.reset();
    this.lastNotify = now;
    await this.write(await this.o.protocol.onNotify(data));
  }

  private async write(commands: Bytes[]): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const p = this.o.protocol;
    for (const c of commands) await conn.write(p.service, p.writeCharacteristic, c, true);
  }

  private onDisconnect(error: Error | null): void {
    this.o.log.warn(`Libre: disconnected${error ? ` (${error.message})` : ''}`);
    this.teardown();
    this.o.onLinkEnded?.();
    if (!this.stopped) {
      this.gate.hold(this.o.protocol.reconnectDelayMs());
      this.rearm();
    }
  }

  /**
   * Arms the next connection at once, with no timer in between. Known peripheral and no delay owed: a pending
   * connect. Otherwise a service-filtered scan without timeout that ignores advertisements until the delay passed
   * (the peripheral's identifier is checked, so a neighbour's transmitter is never picked up).
   */
  private rearm(): void {
    if (this.arming || this.stopped) return;
    this.arming = this.connectArmed()
      .catch((e: unknown) => {
        this.errorValue = (e as Error).message;
        this.o.log.warn(`Libre: reconnect failed (${this.errorValue})`);
        if (!this.stopped && !this.conn) this.retryAfterError();
      })
      .finally(() => {
        this.arming = null;
      });
  }

  private async connectArmed(): Promise<void> {
    const known = await this.o.loadDeviceId();
    if (this.stopped) return; // stop() ran while the id was loaded: do not arm a scan nobody stops
    let id = known;
    if (!known || !this.gate.isOpen) {
      const ad = await scanFirst(this.o.ble, { services: [this.o.protocol.service], timeoutMs: null }, (candidate) => this.gate.isOpen && this.o.protocol.matches(candidate) && (!known || candidate.id === known));
      if (!ad || this.stopped) return;
      id = ad.id;
      if (!known) {
        await this.o.protocol.onSelected?.(ad);
        await this.o.saveDeviceId(ad.id);
      }
    }
    if (!id || this.stopped) return;
    this.pendingId = id;
    let conn: BleConnection;
    try {
      conn = await this.o.ble.connect(id, { timeoutMs: null });
    } finally {
      this.pendingId = null;
    }
    await this.attach(id, conn);
  }

  /**
   * After a reconnect that threw: arm the next pending connect at once, with no timer. A timer stays only for
   * Bluetooth being off (nothing can be armed) and as a guard after a few instant failures in a row.
   */
  private retryAfterError(): void {
    void (async () => {
      const on = (await this.o.ble.state().catch(() => 'unknown')) === 'poweredOn';
      if (this.stopped || this.conn) return;
      if (on && this.immediateRetries < 3) {
        this.immediateRetries++;
        this.rearm();
        return;
      }
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopped && !this.conn) this.rearm();
      }, this.o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    })();
  }
}
