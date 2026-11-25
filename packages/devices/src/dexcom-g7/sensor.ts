/**
 * TypeScript port of G7CGMManager/G7Sensor.swift and the connection logic of
 * G7CGMManager/G7BluetoothManager.swift from loopandlearn/G7SensorKit (MIT, © 2022 LoopKit Authors).
 *
 * G7SensorKit is passive only: it never authenticates itself. It listens on the
 * authentication characteristic; once the official G7 app has authenticated (bonded +
 * authenticated status), it subscribes to control and parses the glucose and backfill traffic.
 *
 * Differences forced by the injected transport (no CoreBluetooth): one connection at a time
 * instead of several managed peripherals, no `retrieveConnectedPeripherals`/state
 * restoration, and the 30 s "connect start delay" after a link ends is a plain wait before
 * scanning again.
 */
import type { BleAdvertisement, BleConnection, BleTransport, Bytes, Clock, Logger } from '@buddy/core';
import { hex } from '@buddy/core';
import { ADVERTISEMENT_SERVICE, CGM_CHARACTERISTIC, CGM_SERVICE, errorOf, NotifyChannel, SerialQueue, Sleeper, withTimeout } from '../dexcom-g6/ble-common';
import {
  G7Opcode,
  parseAuthChallengeRx,
  parseExtendedVersionMessage,
  parseG7BackfillMessage,
  parseG7GlucoseMessage,
  type ExtendedVersionMessage,
  type G7BackfillMessage,
  type G7GlucoseMessage,
} from './messages';

export const G7_DEFAULT_LIFETIME_MS = 10 * 24 * 3600 * 1000;
export const G7_DEFAULT_WARMUP_MS = 27 * 60 * 1000;
export const G7_GRACE_PERIOD_MS = 12 * 3600 * 1000;

export interface G7SensorDelegate {
  sensorDidConnect(name: string): void;
  sensorDisconnected(suspectedEndOfSession: boolean): void;
  didError(error: Error): void;
  didRead(message: G7GlucoseMessage): void;
  didReadBackfill(backfill: readonly G7BackfillMessage[]): void;
  /** If this returns true, then start following this sensor. */
  didDiscoverNewSensor(name: string, activatedAt: number): boolean;
  didReceiveExtendedVersion(message: ExtendedVersionMessage): void;
}

export interface G7Timing {
  readonly scanWindowMs: number;
  /** After the followed sensor's link ends it keeps advertising for a while; wait before reconnecting. */
  readonly reconnectDelayMs: number;
  readonly rescanDelayMs: number;
  readonly responseTimeoutMs: number;
  readonly adapterRetryMs: number;
}

export const DEFAULT_G7_TIMING: G7Timing = {
  scanWindowMs: 60_000,
  reconnectDelayMs: 30_000,
  rescanDelayMs: 2_000,
  responseTimeoutMs: 2_000,
  adapterRetryMs: 5_000,
};

export type PeripheralConnectionCommand = 'makeActive' | 'connect' | 'ignore';

export interface G7SensorOptions {
  readonly sensorID: string | null;
  readonly ble: BleTransport;
  readonly clock: Clock;
  readonly log: Logger;
  readonly delegate: G7SensorDelegate;
  readonly timing?: Partial<G7Timing>;
}

export class G7Sensor {
  /** The activation date of the sensor (epoch ms), derived from the latest glucose message. */
  activationDate: number | null = null;
  needsVersionInfo = false;

  private sensorID: string | null;
  /** Used to detect connections that do not authenticate, signalling possible sensor switchover. */
  private pendingAuth = false;
  /** The backfill data buffer. */
  private backfillBuffer: G7BackfillMessage[] = [];

  private readonly timing: G7Timing;
  private readonly sleeper = new Sleeper();
  private running = false;
  private loop: Promise<void> | null = null;
  private conn: BleConnection | null = null;
  private localDisconnect = false;

  constructor(private readonly o: G7SensorOptions) {
    this.sensorID = o.sensorID;
    this.timing = { ...DEFAULT_G7_TIMING, ...o.timing };
  }

  get followedSensorID(): string | null {
    return this.sensorID;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isConnected(): boolean {
    return this.conn !== null;
  }

  resumeScanning(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop();
  }

  async stopScanning(): Promise<void> {
    this.running = false;
    this.o.ble.stopScan();
    this.sleeper.cancelAll();
    await this.disconnectCurrent();
    await this.loop;
    this.loop = null;
  }

  /** Forgets the followed sensor and looks for any new one. */
  scanForNewSensor(): void {
    this.sensorID = null;
    void this.disconnectCurrent();
    this.sleeper.cancelAll();
  }

  /**
   * The Dexcom G7 advertises a peripheral name of "DXCMxx", and later reports a full name of "Dexcomxx".
   * Dexcom One+ peripheral names start with "DX02".
   */
  shouldConnect(name: string | null): PeripheralConnectionCommand {
    if (!name) return 'ignore';
    if (name.startsWith('DXCM') || name.startsWith('DX02')) {
      // If we're following this name or if we're scanning, connect
      if (this.sensorID !== null && name.slice(-2) === this.sensorID.slice(-2)) return 'makeActive';
      if (this.sensorID === null) return 'connect';
    }
    this.o.log.info(`Dexcom G7: not connecting to peripheral ${name}`);
    return 'ignore';
  }

  private async disconnectCurrent(): Promise<void> {
    if (!this.conn) return;
    this.localDisconnect = true;
    await this.conn.disconnect().catch(() => undefined);
  }

  // ── connection loop (G7BluetoothManager) ────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (this.running) {
      let delay = this.timing.rescanDelayMs;
      try {
        if ((await this.o.ble.state()) !== 'poweredOn') {
          await this.sleeper.sleep(this.timing.adapterRetryMs);
          continue;
        }
        const ad = await this.scanForPeripheral();
        if (!ad || !this.running) continue;
        const wasActive = await this.runConnection(ad);
        if (wasActive && !this.localDisconnect) delay = this.timing.reconnectDelayMs;
      } catch (e) {
        this.o.delegate.didError(errorOf(e));
      }
      if (this.running) await this.sleeper.sleep(delay);
    }
  }

  private async scanForPeripheral(): Promise<BleAdvertisement | null> {
    let found: BleAdvertisement | null = null;
    await this.o.ble.scan({ services: [ADVERTISEMENT_SERVICE], timeoutMs: this.timing.scanWindowMs }, (ad) => {
      if (found || this.shouldConnect(ad.name) === 'ignore') return;
      found = ad;
      this.o.ble.stopScan();
    });
    return found;
  }

  /** Returns whether the link was to the followed ("active") sensor. */
  private async runConnection(ad: BleAdvertisement): Promise<boolean> {
    const name = ad.name ?? '';
    const conn = await this.o.ble.connect(ad.id);
    this.conn = conn;
    this.localDisconnect = false;
    const disconnected = new Promise<Error | null>((resolve) => conn.onDisconnect(resolve));
    const queue = new SerialQueue((e) => this.o.delegate.didError(e));
    const control: NotifyChannel = new NotifyChannel(conn, CGM_CHARACTERISTIC.control, (d) => this.didReceiveControlResponse(d, name, conn, backfill, queue));
    const backfill = new NotifyChannel(conn, CGM_CHARACTERISTIC.backfill, (d) => this.didReceiveBackfillResponse(d));
    const authentication = new NotifyChannel(conn, CGM_CHARACTERISTIC.authentication, (d) => {
      const message = parseAuthChallengeRx(d);
      if (message?.isBonded && message.isAuthenticated) {
        this.o.log.info('Dexcom G7: observed authenticated session, enabling notifications for control characteristic');
        this.pendingAuth = false;
        queue.perform(() => control.listen(this.timing.responseTimeoutMs));
      } else {
        this.o.log.info(`Dexcom G7: ignoring authentication response ${hex(d)}`);
      }
    });
    try {
      // readied
      if (this.sensorID !== null && this.sensorID === name) this.o.delegate.sensorDidConnect(name);
      this.o.log.info(`Dexcom G7: listening for authentication responses for ${name}`);
      queue.perform(async () => {
        await authentication.listen(this.timing.responseTimeoutMs);
        this.pendingAuth = true;
      });
      const error = await disconnected;
      if (error) this.o.log.info(`Dexcom G7: disconnected: ${error.message}`);
      const wasRemoteDisconnect = !this.localDisconnect;
      return this.peripheralDidDisconnect(name, wasRemoteDisconnect);
    } finally {
      for (const ch of [authentication, control, backfill]) {
        ch.failAll(new Error('Disconnected'));
        ch.stopListening();
      }
      await queue.drain();
      this.conn = null;
    }
  }

  private peripheralDidDisconnect(name: string, wasRemoteDisconnect: boolean): boolean {
    if (this.sensorID === null || this.sensorID !== name) {
      this.pendingAuth = false;
      return false;
    }
    // Sometimes we do not receive the backfillFinished message before disconnect
    this.flushBackfillBuffer();
    // Normal disconnect without auth is likely that the G7 app stopped this session
    const suspectedEndOfSession = this.pendingAuth && wasRemoteDisconnect;
    this.o.log.info(`Dexcom G7: sensor disconnected, wasRemoteDisconnect=${wasRemoteDisconnect}`);
    this.pendingAuth = false;
    this.o.delegate.sensorDisconnected(suspectedEndOfSession);
    return true;
  }

  // ── notifications ───────────────────────────────────────────────────────────

  private didReceiveControlResponse(response: Bytes, name: string, conn: BleConnection, backfill: NotifyChannel, queue: SerialQueue): void {
    if (response.length === 0) return;
    this.o.log.info(`Dexcom G7: received control response ${hex(response)}`);
    switch (response[0]) {
      case G7Opcode.glucoseTx: {
        const message = parseG7GlucoseMessage(response);
        if (message) this.handleGlucoseMessage(message, name, conn, backfill, queue);
        else this.o.delegate.didError(new Error('Unable to handle glucose control response'));
        return;
      }
      case G7Opcode.extendedVersionTx: {
        const version = parseExtendedVersionMessage(response);
        if (version) {
          this.o.delegate.didReceiveExtendedVersion(version);
          this.needsVersionInfo = false;
        }
        return;
      }
      case G7Opcode.backfillFinished:
        this.flushBackfillBuffer();
        return;
      default:
        return;
    }
  }

  private handleGlucoseMessage(message: G7GlucoseMessage, name: string, conn: BleConnection, backfill: NotifyChannel, queue: SerialQueue): void {
    this.activationDate = this.o.clock.now() - message.messageTimestamp * 1000;
    queue.perform(async () => {
      // Subscribe to backfill updates
      try {
        await backfill.listen(this.timing.responseTimeoutMs);
      } catch (e) {
        this.o.log.error(`Dexcom G7: error enabling notifications on backfill characteristic: ${errorOf(e).message}`);
        this.o.delegate.didError(errorOf(e));
      }
    });
    const requestVersion = () =>
      queue.perform(async () => {
        try {
          await this.requestExtendedVersion(conn);
        } catch (e) {
          this.o.log.error(`Dexcom G7: error requesting extended version: ${errorOf(e).message}`);
        }
      });
    if (this.needsVersionInfo && name && name === this.sensorID) requestVersion();

    if (this.sensorID === null && name && this.activationDate !== null) {
      if (this.o.delegate.didDiscoverNewSensor(name, this.activationDate)) {
        this.sensorID = name;
        this.needsVersionInfo = true;
        this.o.delegate.didRead(message);
        requestVersion();
      }
    } else if (this.sensorID !== null) {
      this.o.delegate.didRead(message);
    } else {
      this.o.log.error(`Dexcom G7: dropping unhandled glucose message ${hex(message.data)}`);
    }
  }

  private requestExtendedVersion(conn: BleConnection): Promise<void> {
    this.o.log.info('Dexcom G7: requesting sensor extended version');
    return withTimeout(
      conn.write(CGM_SERVICE, CGM_CHARACTERISTIC.control, new Uint8Array([G7Opcode.extendedVersionTx]), true),
      1_000,
      'Timed out requesting extended version',
    );
  }

  private didReceiveBackfillResponse(response: Bytes): void {
    if (response.length !== 9) return;
    const message = parseG7BackfillMessage(response);
    if (message) this.backfillBuffer = [...this.backfillBuffer, message];
  }

  private flushBackfillBuffer(): void {
    if (this.backfillBuffer.length === 0) return;
    const backfill = this.backfillBuffer;
    this.backfillBuffer = [];
    this.o.delegate.didReadBackfill(backfill);
  }
}
