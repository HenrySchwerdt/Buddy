/**
 * "Heartbeat transmitter": any nearby BLE device that connects, notifies or drops its link periodically, used only
 * as a wake-up source for the loop. A port of the behaviour of Trio's `CGM/BluetoothTransmitter.swift`, which
 * Trio uses for CGMs that are not Bluetooth themselves (Nightscout, LibreLinkUp, xDrip app group).
 *
 * Like Trio it keeps a connection to the chosen peripheral for good: a pending connect (no timeout), which
 * CoreBluetooth keeps alive while iOS has the app suspended and which wakes the app when the device connects. It
 * subscribes to every notifying characteristic it finds, and treats each connect, each notification and each
 * disconnect as a heartbeat. After a disconnect the next pending connect is armed in the same call (Trio:
 * `didDisconnectPeripheral` -> `centralManager.connect`), with no timer in between.
 *
 * The device's own protocol is never spoken: values are ignored, only their arrival counts.
 */
import type { BleAdvertisement, BleConnection, BleTransport, Clock, Logger } from '@buddy/core';

export interface HeartbeatTransmitterOptions {
  readonly ble: BleTransport;
  readonly clock: Clock;
  readonly log: Logger;
  /** The peripheral id the user picked (CoreBluetooth UUID on iOS, MAC address on Android). */
  readonly deviceId: string;
  /** Called for every connect, notification and disconnect (notifications at most once per `minNotifyIntervalMs`). */
  readonly onHeartbeat: () => void;
  /** Chatty devices (a notification every second) must not wake the loop logic that often. Default 5 s. */
  readonly minNotifyIntervalMs?: number;
  /** Wait before trying again after a connect that failed with an error (never after a normal disconnect). Default 5 s. */
  readonly retryDelayMs?: number;
}

const DEFAULT_MIN_NOTIFY_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

export class HeartbeatTransmitter {
  private running = false;
  private conn: BleConnection | null = null;
  private cleanups: (() => void)[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNotifyBeat = Number.NEGATIVE_INFINITY;
  private arming = false;

  constructor(private readonly o: HeartbeatTransmitterOptions) {}

  get deviceId(): string {
    return this.o.deviceId;
  }

  get connected(): boolean {
    return this.conn !== null;
  }

  /** Arms the pending connect. Never rejects: a device that is not there simply stays pending. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.arm();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.o.ble.cancelConnect?.(this.o.deviceId);
    const conn = this.conn;
    this.release();
    if (conn) await conn.disconnect().catch(() => {});
  }

  private release(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.conn = null;
  }

  private beat(): void {
    try {
      this.o.onHeartbeat();
    } catch (e) {
      this.o.log.warn(`Heartbeat transmitter: listener failed (${(e as Error).message})`);
    }
  }

  private async arm(): Promise<void> {
    if (!this.running || this.arming || this.conn) return;
    this.arming = true;
    try {
      const conn = await this.o.ble.connect(this.o.deviceId, { timeoutMs: null });
      if (!this.running) {
        await conn.disconnect().catch(() => {});
        return;
      }
      await this.attach(conn);
    } catch (e) {
      if (this.running) {
        this.o.log.warn(`Heartbeat transmitter: connect failed (${(e as Error).message}); retrying`);
        this.retryLater();
      }
    } finally {
      this.arming = false;
      // The link may have dropped while it was being set up (the disconnect found `arming` set and could not re-arm).
      if (this.running && !this.conn && !this.retryTimer) void this.arm();
    }
  }

  private async attach(conn: BleConnection): Promise<void> {
    this.conn = conn;
    this.cleanups.push(conn.onDisconnect((error) => this.onDisconnect(error)));
    this.o.log.info('Heartbeat transmitter: connected');
    this.beat();
    try {
      if (conn.subscribeAll) {
        this.cleanups.push(
          await conn.subscribeAll(() => {
            const now = this.o.clock.now();
            if (now - this.lastNotifyBeat < (this.o.minNotifyIntervalMs ?? DEFAULT_MIN_NOTIFY_INTERVAL_MS)) return;
            this.lastNotifyBeat = now;
            this.beat();
          }),
        );
      }
    } catch (e) {
      // The connect itself is already a heartbeat source (and so is the disconnect); notifications are a bonus.
      this.o.log.warn(`Heartbeat transmitter: could not subscribe (${(e as Error).message})`);
    }
  }

  private onDisconnect(error: Error | null): void {
    this.o.log.info(`Heartbeat transmitter: disconnected${error ? ` (${error.message})` : ''}`);
    this.release();
    this.beat();
    // Re-armed in the same call: no timer between the disconnect and the next pending connect.
    if (this.running) void this.arm();
  }

  private retryLater(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.arm();
    }, this.o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }
}

/** A device found while looking for a heartbeat transmitter. */
export interface NearbyBleDevice {
  readonly id: string;
  readonly name: string | null;
  readonly rssi: number | null;
}

/**
 * Looks around for `durationMs` (foreground; the unfiltered scan iOS only allows in the foreground) and returns
 * every named peripheral heard, strongest signal first. Unnamed peripherals are skipped: the user could not tell
 * them apart, and most are other people's phones.
 */
export async function scanNearbyDevices(ble: BleTransport, options: { readonly durationMs: number; readonly onFound?: (devices: readonly NearbyBleDevice[]) => void }): Promise<NearbyBleDevice[]> {
  const found = new Map<string, NearbyBleDevice>();
  const sorted = () => [...found.values()].sort((a, b) => (b.rssi ?? -127) - (a.rssi ?? -127));
  await ble.scan({ timeoutMs: options.durationMs, allowDuplicates: true }, (ad: BleAdvertisement) => {
    if (!ad.name) return;
    const previous = found.get(ad.id);
    // A device is reported many times; keep the strongest reading and tell the caller only about changes.
    if (previous && (ad.rssi ?? -127) <= (previous.rssi ?? -127)) return;
    found.set(ad.id, { id: ad.id, name: ad.name, rssi: ad.rssi });
    if (!previous) options.onFound?.(sorted());
  });
  return sorted();
}
