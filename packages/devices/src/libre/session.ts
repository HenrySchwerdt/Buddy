/**
 * BLE connection handling for the Libre drivers. Condensed TypeScript port of the connection
 * logic in `Bluetooth/Transmitter/LibreTransmitterProxyManager.swift` from
 * loopandlearn/LibreTransmitter (MIT, (c) the LibreTransmitter authors): scan for a matching
 * peripheral, remember its identifier, enable notifications, hand writes/notifications to the
 * protocol, reconnect after disconnects (7 s delay for MiaoMiao/Bubble, immediate for Libre 2)
 * and reset the receive buffer when a session goes quiet for more than 6 s.
 */
import type { BleAdvertisement, BleConnection, BleTransport, Bytes, Clock, Logger } from '@buddy/core';

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
  readonly retryDelayMs?: number;
}

const QUIET_RESET_MS = 6_000;
const DEFAULT_SCAN_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;

export class LibreBleSession {
  private conn: BleConnection | null = null;
  private cleanups: (() => void)[] = [];
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastNotify: number | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: SessionOptions) {}

  get connected(): boolean {
    return this.conn !== null;
  }

  /** Finds (or reuses) the peripheral and connects. Rejects if the first connection fails. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    const state = await this.o.ble.state();
    if (state !== 'poweredOn') throw new Error(`Bluetooth is not available (${state})`);
    this.stopped = false;
    try {
      await this.connectOnce();
    } catch (e) {
      this.stopped = true;
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.o.ble.stopScan();
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
    let found: BleAdvertisement | null = null;
    await this.o.ble.scan({ services: [this.o.protocol.service], timeoutMs: this.o.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS }, (ad) => {
      if (found || !this.o.protocol.matches(ad)) return;
      found = ad;
      this.o.ble.stopScan();
    });
    const ad = found as BleAdvertisement | null;
    if (!ad) throw new Error('No matching Libre sensor or transmitter found nearby');
    await this.o.protocol.onSelected?.(ad);
    await this.o.saveDeviceId(ad.id);
    return ad.id;
  }

  private async connectOnce(): Promise<void> {
    const id = await this.findDevice();
    if (this.stopped) return;
    const conn = await this.o.ble.connect(id, { timeoutMs: 30_000 });
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
    if (!this.stopped) this.scheduleReconnect(this.o.protocol.reconnectDelayMs());
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.connectOnce().catch((e: unknown) => {
        this.o.log.warn(`Libre: reconnect failed (${(e as Error).message})`);
        if (!this.stopped && !this.conn) this.scheduleReconnect(this.o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      });
    }, delayMs);
  }
}
