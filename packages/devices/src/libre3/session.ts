/**
 * One BLE connection to a Libre 3: authorization, data-plane subscription, frame decoding,
 * encrypted patchControl writes and the silence watchdog.
 *
 * TypeScript port of the session handling in RoundWhiteDiscKit `BLE/SensorSession.swift`
 * (`refreshDataPlaneNotifications`) and LibreLoop `LibreLoopSensorMonitor.swift` (silence watchdog,
 * post-auth CCCD arming, backfill writes) (MIT, (c) the RoundWhiteDiscKit and LibreLoop authors).
 * Session keys (kEnc / ivEnc) live only in memory and are never logged.
 */
import type { BleConnection, Bytes, Clock, Logger } from '@buddy/core';
import {
  DATA_PLANE_CHANNELS, LIBRE3_CHAR, LIBRE3_DATA_SERVICE, type Libre3DataChannel,
} from './constants';
import { DataPlaneCrypto, KIND_PATCH_CONTROL_WRITE, decodeDataPlane, type DecodedPacket } from './data-plane';
import { GlucoseNotificationAssembler, parseDataFrame } from './framing';
import { backfillCommand, type BackfillStream } from './history';
import { runCachedReconnect, runFullAuthorization, type HandshakeOptions, type SessionMaterial } from './handshake';
import type { AppIdentity } from './identity';
import { SecurityLink, WriteTimeoutError, withTimeout } from './link';
import { Mailbox } from './mailbox';
import type { RandomSource } from './random';
import type { Libre3Timing } from './timing';

export interface ConnectionDeps {
  readonly clock: Clock;
  readonly log: Logger;
  readonly timing: Libre3Timing;
  readonly random: RandomSource;
  readonly signingKeys?: readonly Bytes[];
  /** Called for every successfully decoded data-plane packet. */
  readonly onPacket: (packet: DecodedPacket, at: number) => void;
}

export class Libre3ConnectionSession {
  private readonly mailbox = new Mailbox();
  private readonly glucoseAssembler = new GlucoseNotificationAssembler();
  private cleanups: (() => void)[] = [];
  private readonly dataSubscriptions = new Map<Libre3DataChannel, () => void>();
  private crypto: DataPlaneCrypto | null = null;
  private outboundSequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastFrame: Partial<Record<Libre3DataChannel, number>> = {};
  private streamingSince = 0;
  private closed = false;
  /** True once at least one data-plane packet decoded: the link really streamed. */
  streamed = false;
  /** The link dropped; set before any waiter is failed. */
  lost = false;

  constructor(readonly conn: BleConnection, private readonly d: ConnectionDeps, private readonly onMute: () => void) {}

  private handshakeOptions(blePin: Bytes): HandshakeOptions {
    const { timing } = this.d;
    return {
      link: new SecurityLink(this.conn, this.mailbox, { writeMs: timing.writeMs, notifyMs: timing.notifyMs, commandMs: timing.commandMs }),
      random: this.d.random,
      blePin,
      signingKeys: this.d.signingKeys,
    };
  }

  /** Link lost: fail every pending wait. */
  onLinkLost(error: Error): void {
    this.lost = true;
    this.mailbox.close(error);
  }

  /** Cached reconnect with the saved kAuth (does not need an app credential). */
  async authorizeCached(blePin: Bytes, kAuth: Bytes): Promise<void> {
    const options = this.handshakeOptions(blePin);
    this.cleanups.push(await options.link.open());
    this.crypto = this.cryptoFor(await runCachedReconnect(options, kAuth));
  }

  /** Full first-pair / re-pair authorization; returns the kAuth to cache. */
  async authorizeFull(blePin: Bytes, identity: AppIdentity): Promise<Bytes> {
    const options = this.handshakeOptions(blePin);
    this.cleanups.push(await options.link.open());
    const { material, kAuth } = await runFullAuthorization(options, identity);
    this.crypto = this.cryptoFor(material);
    return kAuth;
  }

  private cryptoFor(material: SessionMaterial): DataPlaneCrypto {
    return new DataPlaneCrypto(material.kEnc, material.ivEnc);
  }

  /** Enables the data-plane notifications (all at once: the sensor acknowledges them serially) and starts the watchdog. */
  async startStreaming(): Promise<void> {
    if (!this.crypto) throw new Error('Libre 3: not authorized');
    await Promise.all(DATA_PLANE_CHANNELS.map((channel) => this.arm(channel)));
    this.streamingSince = this.d.clock.now();
    this.watchdog = setInterval(() => void this.checkSilence(), this.d.timing.watchdogIntervalMs);
    (this.watchdog as { unref?: () => void }).unref?.();
  }

  /** (Re-)enables notifications for one channel, replacing an earlier subscription. */
  private async arm(channel: Libre3DataChannel): Promise<void> {
    this.dataSubscriptions.get(channel)?.();
    const unsubscribe = await this.conn.subscribe(LIBRE3_DATA_SERVICE, LIBRE3_CHAR[channel], (data) => this.enqueue(() => this.handleFragment(channel, data)));
    this.dataSubscriptions.set(channel, unsubscribe);
  }

  private enqueue(task: () => void | Promise<void>): void {
    this.queue = this.queue.then(task).catch((e: unknown) => this.d.log.error(`Libre 3: ${(e as Error).message}`));
  }

  /** Resolves once everything received so far is processed (for tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private handleFragment(channel: Libre3DataChannel, fragment: Bytes): void {
    const crypto = this.crypto;
    if (!crypto || this.closed) return;
    const at = this.d.clock.now();
    this.lastFrame[channel] = at;
    const raw = channel === 'glucoseData' ? this.glucoseAssembler.feed(fragment) : fragment;
    if (!raw) return;
    let packet: DecodedPacket;
    try {
      packet = decodeDataPlane(crypto, channel, parseDataFrame(raw));
    } catch (e) {
      this.glucoseAssembler.reset();
      this.d.log.warn(`Libre 3: ${channel} frame rejected (${(e as Error).message})`);
      return;
    }
    this.streamed = true;
    this.d.onPacket(packet, at);
  }

  /** Encrypted patchControl write: `ciphertext || tag || seq_LE2` with the kind-0 descriptor. */
  async sendBackfill(stream: BackfillStream, fromLifeCount: number): Promise<void> {
    if (!this.crypto || this.closed) throw new Error('Libre 3: link is not ready');
    this.outboundSequence = (this.outboundSequence + 1) & 0xffff;
    const frame = this.crypto.encrypt(backfillCommand(stream, fromLifeCount), this.outboundSequence, KIND_PATCH_CONTROL_WRITE);
    await withTimeout(
      this.conn.write(LIBRE3_DATA_SERVICE, LIBRE3_CHAR.patchControl, frame, true),
      this.d.timing.writeMs,
      () => new WriteTimeoutError(`${stream} backfill`, this.d.timing.writeMs),
    );
  }

  /**
   * Silence watchdog (per-channel recovery instead of blanket CCCD churn): patchStatus quiet for a minute is
   * read directly, quiet for 150 s it is re-armed; glucose quiet for 150 s is re-armed; a completely
   * silent link is dropped so the reconnect starts clean.
   */
  async checkSilence(): Promise<void> {
    if (this.closed || !this.crypto) return;
    const now = this.d.clock.now();
    const quiet = (c: Libre3DataChannel): number => now - (this.lastFrame[c] ?? this.streamingSince);
    const { timing } = this.d;
    const all = Math.min(...DATA_PLANE_CHANNELS.map(quiet));
    if (all >= timing.muteResetAfterMs) {
      this.d.log.warn(`Libre 3: no data for ${Math.round(all / 1000)} s; dropping the link to reconnect`);
      this.onMute();
      return;
    }
    if (quiet('patchStatus') >= timing.patchStatusReadAfterMs) {
      if (quiet('patchStatus') >= timing.rearmAfterMs) await this.rearm('patchStatus');
      try {
        const data = await withTimeout(this.conn.read(LIBRE3_DATA_SERVICE, LIBRE3_CHAR.patchStatus), timing.writeMs, () => new Error('patchStatus read timed out'));
        this.enqueue(() => this.handleFragment('patchStatus', data));
      } catch (e) {
        this.d.log.warn(`Libre 3: patchStatus read failed (${(e as Error).message})`);
      }
      this.lastFrame.patchStatus = now; // do not re-issue every tick while waiting for the result
    }
    if (quiet('glucoseData') >= timing.rearmAfterMs) {
      await this.rearm('glucoseData');
      this.lastFrame.glucoseData = now;
    }
  }

  private async rearm(channel: Libre3DataChannel): Promise<void> {
    try {
      this.d.log.info(`Libre 3: re-arming ${channel} notifications`);
      await this.arm(channel);
    } catch (e) {
      this.d.log.warn(`Libre 3: could not re-arm ${channel} (${(e as Error).message})`);
    }
  }

  get lastFrameAt(): Partial<Record<Libre3DataChannel, number>> {
    return this.lastFrame;
  }

  /** Stops timers and subscriptions; optionally drops the connection. */
  async close(disconnect: boolean): Promise<void> {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.mailbox.close(new Error('Libre 3 link closed'));
    for (const c of [...this.cleanups, ...this.dataSubscriptions.values()]) c();
    this.cleanups = [];
    this.dataSubscriptions.clear();
    if (disconnect) await this.conn.disconnect().catch(() => {});
  }
}
