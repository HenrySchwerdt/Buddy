/**
 * Connection engine of the Libre 3 CGM source: finds the sensor, authorizes (cached kAuth, or the
 * full handshake with an app credential), streams, and reconnects with backoff for as long as it
 * runs. Replaces the reconnect machinery of LibreLoop `LibreLoopCGMManager+Pairing.swift`
 * (`scheduleReconnect`, `runReconnectOnce`, `handleMonitorDisconnect`) and the connection logic of
 * `LibreLoopPairingService.reconnect` (MIT, (c) the LibreLoop authors).
 *
 * Policy carried over from LibreLoop: an already-active sensor only accepts the cached path; a failed
 * cached reconnect is never answered with a full handshake, it backs off and eventually asks for a
 * re-scan over NFC. The full handshake is for the first connection after (re-)pairing.
 */
import type { BleConnection, BleTransport, Bytes, Clock, Logger, SecretStore } from '@buddy/core';
import { LIBRE3_DATA_SERVICE } from './constants';
import type { DecodedPacket } from './data-plane';
import { loadAppIdentities, type AppIdentity } from './identity';
import { advertisedNameForAddress } from './nfc';
import type { ReadingPipeline } from './pipeline';
import type { RandomSource } from './random';
import { Libre3ConnectionSession } from './session';
import type { SensorStateHolder } from './state-holder';
import type { Libre3Timing } from './timing';

export type Libre3Phase = 'idle' | 'connecting' | 'authorizing' | 'streaming' | 'reconnecting' | 'ended';

export interface Libre3EngineOptions {
  readonly ble: BleTransport;
  readonly secrets: SecretStore;
  readonly clock: Clock;
  readonly log: Logger;
  readonly holder: SensorStateHolder;
  readonly pipeline: ReadingPipeline;
  readonly timing: Libre3Timing;
  readonly random: RandomSource;
  readonly signingKeys?: readonly Bytes[];
}

const MAX_KNOWN_ID_CONNECT_FAILURES = 3;

export class Libre3Engine {
  private phase: Libre3Phase = 'idle';
  private session: Libre3ConnectionSession | null = null;
  private stopped = true;
  private ended = false;
  /** A connection attempt is in flight; it observes link failures itself. */
  private connecting = false;
  private failures = 0;
  private authFailures = 0;
  private knownIdFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt: Promise<void> | null = null;

  constructor(private readonly o: Libre3EngineOptions) {}

  get state(): { phase: Libre3Phase; needsRepair: boolean; failures: number } {
    return { phase: this.phase, needsRepair: this.authFailures >= this.o.timing.authFailuresBeforeRepair, failures: this.failures };
  }

  /** Connects once (rejects on failure), then keeps the link up until `stop()`. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    const bluetooth = await this.o.ble.state();
    if (bluetooth !== 'poweredOn') throw new Error(`Bluetooth is not available (${bluetooth})`);
    if (this.o.holder.current.needsReplacement) throw new Error('The Libre 3 sensor reported that it ended. Replace it and pair the new sensor.');
    this.stopped = false;
    this.ended = false;
    this.failures = 0;
    this.authFailures = 0;
    try {
      await this.connectOnce();
    } catch (e) {
      this.stopped = true;
      this.phase = 'idle';
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      await this.dropSession(true);
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.o.ble.stopScan();
    this.o.pipeline.detach();
    await this.dropSession(true);
    this.phase = 'idle';
    await this.o.holder.flush();
  }

  /** Resolves when the in-flight connection attempt and the packet queue have settled (for tests). */
  async idle(): Promise<void> {
    await this.attempt?.catch(() => {});
    await this.session?.idle();
  }

  /** Runs one silence-watchdog pass now (for tests). */
  checkSilence(): Promise<void> {
    return this.session?.checkSilence() ?? Promise.resolve();
  }

  /** Called by the pipeline: the sensor ended or must be replaced; stop retrying. */
  sensorEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.o.log.warn('Libre 3: the sensor ended; no further reconnects. Replace it and pair the new sensor.');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.phase = 'ended';
    this.o.pipeline.detach();
    void this.dropSession(true);
  }

  private async findPeripheral(): Promise<string> {
    const sensor = this.o.holder.current;
    if (sensor.peripheralId) return sensor.peripheralId;
    const expected = advertisedNameForAddress(sensor.bleAddress);
    let found: string | null = null;
    await this.o.ble.scan({ services: [LIBRE3_DATA_SERVICE], timeoutMs: this.o.timing.scanTimeoutMs }, (ad) => {
      if (found !== null || ad.name?.toUpperCase() !== expected) return;
      found = ad.id;
      this.o.ble.stopScan();
    });
    if (found === null) throw new Error('Libre 3 sensor not found nearby (is it on your arm and Bluetooth on?)');
    this.o.holder.update({ peripheralId: found });
    await this.o.holder.flush();
    return found;
  }

  private async connectPeripheral(): Promise<BleConnection> {
    const id = await this.findPeripheral();
    try {
      const conn = await this.o.ble.connect(id, { timeoutMs: this.o.timing.connectTimeoutMs });
      this.knownIdFailures = 0;
      return conn;
    } catch (e) {
      // a stale peripheral id: forget it after a few failures so the next attempt scans again
      if (++this.knownIdFailures >= MAX_KNOWN_ID_CONNECT_FAILURES) {
        this.knownIdFailures = 0;
        this.o.holder.update({ peripheralId: null });
      }
      throw e;
    }
  }

  private newSession(conn: BleConnection): Libre3ConnectionSession {
    const session = new Libre3ConnectionSession(
      conn,
      {
        clock: this.o.clock,
        log: this.o.log,
        timing: this.o.timing,
        random: this.o.random,
        signingKeys: this.o.signingKeys,
        onPacket: (packet: DecodedPacket, at: number) => {
          this.failures = 0;
          this.authFailures = 0;
          this.o.pipeline.handle(packet, at);
        },
      },
      () => void conn.disconnect().catch(() => {}),
    );
    conn.onDisconnect((error) => this.onDisconnect(session, error));
    return session;
  }

  /** Authorizes `session`: cached kAuth when available, otherwise the full handshake over the installed credentials. */
  private async authorize(session: Libre3ConnectionSession, identity: AppIdentity | null): Promise<void> {
    const sensor = this.o.holder.current;
    if (sensor.kAuth) {
      await session.authorizeCached(sensor.blePin, sensor.kAuth);
      return;
    }
    if (!identity) throw new Error('Libre 3: no app credential installed for the first-pair handshake');
    const kAuth = await session.authorizeFull(sensor.blePin, identity);
    this.o.holder.update({ kAuth, appIdentity: identity.label });
    await this.o.holder.flush();
  }

  private async connectOnce(): Promise<void> {
    this.connecting = true;
    try {
      await this.connectAttempt();
    } finally {
      this.connecting = false;
    }
  }

  private async connectAttempt(): Promise<void> {
    this.phase = this.phase === 'streaming' || this.phase === 'reconnecting' ? 'reconnecting' : 'connecting';
    const sensor = this.o.holder.current;
    const identities = sensor.kAuth ? [null] : await this.credentialOrder(sensor.appIdentity);
    if (identities.length === 0) throw new Error('Libre 3: no app credential installed (needed for the first connection after pairing)');
    let lastError: unknown = null;
    for (const identity of identities) {
      if (this.stopped) return;
      const conn = await this.connectPeripheral();
      const session = this.newSession(conn);
      this.session = session;
      this.phase = 'authorizing';
      try {
        try {
          await this.authorize(session, identity);
        } catch (e) {
          // a sensor that refuses the saved authorization just drops the link, indistinguishable from a link fault
          this.authFailures++;
          throw e;
        }
        await session.startStreaming();
        if (session.lost) throw new Error('Libre 3 link lost while connecting');
        if (this.stopped || this.session !== session) return;
        this.o.pipeline.attach({ send: (stream, from) => session.sendBackfill(stream, from) });
        this.phase = 'streaming';
        this.o.log.info(`Libre 3: connected to sensor ${sensor.serialNumber}`);
        return;
      } catch (e) {
        lastError = e;
        await this.dropSession(true);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Libre 3 connection failed');
  }

  private async credentialOrder(preferred: string | null): Promise<(AppIdentity | null)[]> {
    const all = await loadAppIdentities(this.o.secrets);
    return [...all.filter((i) => i.label === preferred), ...all.filter((i) => i.label !== preferred)];
  }

  private async dropSession(disconnect: boolean): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.close(disconnect);
  }

  private onDisconnect(session: Libre3ConnectionSession, error: Error | null): void {
    session.onLinkLost(error ?? new Error('Libre 3 disconnected'));
    if (this.session !== session) return;
    this.o.log.warn(`Libre 3: disconnected${error ? ` (${error.message})` : ''}`);
    if (this.connecting) return; // the in-flight attempt fails on its own and decides about retrying
    if (!session.streamed) this.failures++;
    this.o.pipeline.detach();
    void this.dropSession(false);
    if (!this.stopped && !this.ended) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || this.ended) return;
    this.phase = 'reconnecting';
    const delay = this.o.timing.reconnectDelayMs(this.failures);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.ended) return;
      this.attempt = this.connectOnce()
        .catch((e: unknown) => {
          this.failures++;
          this.o.log.warn(`Libre 3: reconnect failed (${(e as Error).message})`);
          if (this.authFailures === this.o.timing.authFailuresBeforeRepair) {
            this.o.log.warn('Libre 3: the sensor keeps refusing the saved authorization. Scan it with NFC again to re-pair.');
          }
          if (!this.stopped && !this.ended && !this.session) this.scheduleReconnect();
        })
        .finally(() => {
          this.attempt = null;
        });
    }, delay);
  }
}
