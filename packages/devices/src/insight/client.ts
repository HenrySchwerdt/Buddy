/**
 * Typed operations of section 5.1 (port of InsightKit `InsightBridgeClient` / `SessionBridgeClient`)
 * on top of a self-healing session: the client connects on demand, drops a dead session and
 * reconnects with the next command.
 *
 * Failure semantics (what dosing code depends on):
 * - A command that fails while no session could be established is a *certain* `notConnected`
 *   (nothing was sent).
 * - After a dosing request left the phone, an unreadable answer is an *uncertain* remote error,
 *   never a clean failure.
 */
import type { Clock, Logger } from '@buddy/core';
import type { RandomSource } from './bytes';
import { BridgeConnector } from './connector';
import type { InsightTimeouts } from './constants';
import { HISTORY_PAGE_SIZE } from './constants';
import type { InsightCredentials } from './credentials';
import {
  BridgeError,
  formatBridgeDate,
  isDosingOp,
  parseCancelBolus,
  parseDeliverBolus,
  parseHistoryPage,
  parseOperatingModeResult,
  parsePumpPairingStatus,
  parseRequestOutcome,
  parseSetTbr,
  parseStatus,
  type BridgeEvent,
  type BridgeOp,
  type BridgeStatus,
  type CancelBolusResult,
  type DeliverBolusResult,
  type HelloResult,
  type HistoryPage,
  type JsonObject,
  type JsonValue,
  type OperatingModeResult,
  type PumpPairingStatus,
  type RequestOutcome,
  type SetTbrResult,
} from './models';
import type { InsightSession } from './session';
import type { BleTransport } from '@buddy/core';

/** A session without traffic for this long is probed with a ping before it is trusted with a command. */
const LIVENESS_PROBE_MS = 90_000;

export interface BasalSegmentArg {
  readonly duration: number;
  readonly rate: number;
}

/** The operations the driver needs; tests may substitute their own implementation. */
export interface InsightBridgeClient {
  /** A session is up right now (no connect is attempted). */
  readonly isReady: boolean;
  readonly hello: HelloResult | null;
  /** The remembered (or last authenticated) peripheral id. */
  readonly peripheralId: string | null;
  /** The bridge rejected this phone twice: pair again. */
  readonly needsRepair: boolean;
  /** Brings up a session (scan, connect, handshake) or throws a certain `BridgeError`. */
  ensureSession(): Promise<void>;
  /** Starting point for the next connect (the bridge's address rotates). */
  setPeripheral(id: string | null): void;
  /** Drops the session (a running request fails as "link lost"). */
  disconnect(): Promise<void>;
  onEvent(listener: (e: BridgeEvent) => void): () => void;
  /** The session went down. */
  onSessionLost(listener: () => void): () => void;

  getStatus(): Promise<BridgeStatus>;
  deliverBolus(amount: number, requestId: string): Promise<DeliverBolusResult>;
  cancelBolus(bolusId: number): Promise<CancelBolusResult>;
  setTBR(percent: number, duration: number, requestId: string): Promise<SetTbrResult>;
  cancelTBR(requestId: string): Promise<void>;
  setOperatingMode(mode: 'started' | 'stopped', requestId: string): Promise<OperatingModeResult>;
  setBasalProfile(segments: readonly BasalSegmentArg[], requestId: string): Promise<void>;
  setDateTime(utcMs: number, tzOffsetMinutes: number): Promise<void>;
  readHistory(sinceSequence: number | null, max?: number): Promise<HistoryPage>;
  confirmAlert(alertId: number, alertType: string): Promise<void>;
  snoozeAlert(alertId: number, alertType: string): Promise<void>;
  getRequestOutcome(requestId: string): Promise<RequestOutcome>;
  pumpPairingStatus(): Promise<PumpPairingStatus>;
}

export interface SessionClientOptions {
  readonly ble: BleTransport;
  readonly clock: Clock;
  readonly log: Logger;
  readonly timeouts: InsightTimeouts;
  readonly random: RandomSource;
  readonly appName: string;
  readonly credentials: () => Promise<InsightCredentials | null>;
  /** Called when a (possibly new) peripheral id authenticated: persist it. */
  readonly onAdoptPeripheral?: (id: string) => void;
}

export class SessionBridgeClient implements InsightBridgeClient {
  private session: InsightSession | null = null;
  private connecting: Promise<void> | null = null;
  private target: string | null;
  private readonly connector: BridgeConnector;
  private readonly eventListeners = new Set<(e: BridgeEvent) => void>();
  private readonly lostListeners = new Set<() => void>();

  constructor(
    private readonly opts: SessionClientOptions,
    initialPeripheral: string | null,
  ) {
    this.target = initialPeripheral;
    this.connector = new BridgeConnector({ ble: opts.ble, clock: opts.clock, log: opts.log, timeouts: opts.timeouts, random: opts.random, appName: opts.appName });
  }

  get isReady(): boolean {
    return this.session?.isOpen === true;
  }
  get hello(): HelloResult | null {
    return this.session?.hello ?? null;
  }
  get peripheralId(): string | null {
    return this.target;
  }
  get needsRepair(): boolean {
    return this.connector.requiresRepair;
  }

  /** Forget a "needs re-pair" verdict (after pairing again). */
  resetRepair(target: string | null): void {
    this.connector.reset();
    if (target) this.target = target;
  }

  onEvent(listener: (e: BridgeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onSessionLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  setPeripheral(id: string | null): void {
    if (id) this.target = id;
  }

  /**
   * A session that has been quiet for a while may be half-open (the phone on the other side went away
   * without the link noticing). Finding out *before* a dosing command is sent keeps a dead link from
   * turning into an unknown outcome: the probe fails, the session is dropped and a new one is made.
   */
  async ensureSession(): Promise<void> {
    const open = this.session;
    if (open?.isOpen && open.idleMs() > LIVENESS_PROBE_MS) {
      try {
        await open.request('ping');
      } catch {
        // A missing answer tears the session down (requestTimedOut); reconnect below.
      }
    }
    if (this.isReady) return;
    this.connecting ??= this.connectNow().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectNow(): Promise<void> {
    const creds = await this.opts.credentials();
    if (!creds) throw new BridgeError('missingCredentials');
    const { session, peripheralId } = await this.connector.connect(creds, this.target);
    this.session = session;
    if (peripheralId !== this.target) {
      this.target = peripheralId;
      this.opts.onAdoptPeripheral?.(peripheralId);
    }
    session.onEvent((e) => this.eventListeners.forEach((l) => l(e)));
    session.onClosed(() => {
      if (this.session === session) this.session = null;
      this.lostListeners.forEach((l) => l());
    });
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    this.session = null;
    await s?.close();
  }

  private async call(op: BridgeOp, args: JsonObject = {}): Promise<JsonValue> {
    await this.ensureSession();
    const session = this.session;
    if (!session?.isOpen) throw new BridgeError('notConnected');
    return session.request(op, args);
  }

  /**
   * Decodes a result; for dosing ops an unreadable answer is an unknown outcome, not a clean failure
   * (the command was accepted by the transport, the answer just cannot be trusted).
   */
  private decode<T>(op: BridgeOp, value: JsonValue, parse: (v: unknown) => T | null): T {
    const parsed = parse(value);
    if (parsed !== null) return parsed;
    throw isDosingOp(op) ? BridgeError.remote('internal', 'unreadable response', true) : new BridgeError('decoding', null, op);
  }

  async getStatus(): Promise<BridgeStatus> {
    return this.decode('getStatus', await this.call('getStatus'), parseStatus);
  }
  async deliverBolus(amount: number, requestId: string): Promise<DeliverBolusResult> {
    return this.decode('deliverBolus', await this.call('deliverBolus', { amount, requestId }), parseDeliverBolus);
  }
  async cancelBolus(bolusId: number): Promise<CancelBolusResult> {
    return this.decode('cancelBolus', await this.call('cancelBolus', { bolusId }), parseCancelBolus);
  }
  async setTBR(percent: number, duration: number, requestId: string): Promise<SetTbrResult> {
    return this.decode('setTBR', await this.call('setTBR', { percent, duration, requestId }), parseSetTbr);
  }
  async cancelTBR(requestId: string): Promise<void> {
    await this.call('cancelTBR', { requestId });
  }
  async setOperatingMode(mode: 'started' | 'stopped', requestId: string): Promise<OperatingModeResult> {
    return this.decode('setOperatingMode', await this.call('setOperatingMode', { mode, requestId }), parseOperatingModeResult);
  }
  async setBasalProfile(segments: readonly BasalSegmentArg[], requestId: string): Promise<void> {
    await this.call('setBasalProfile', { segments: segments.map((s) => ({ duration: s.duration, rate: s.rate })), requestId });
  }
  async setDateTime(utcMs: number, tzOffsetMinutes: number): Promise<void> {
    await this.call('setDateTime', { utc: formatBridgeDate(utcMs), tzOffsetMinutes });
  }
  async readHistory(sinceSequence: number | null, max = HISTORY_PAGE_SIZE): Promise<HistoryPage> {
    // `null` must be sent explicitly: the contract says "int | null"
    return this.decode('readHistory', await this.call('readHistory', { sinceSequence, max: Math.min(max, HISTORY_PAGE_SIZE) }), parseHistoryPage);
  }
  async confirmAlert(alertId: number, alertType: string): Promise<void> {
    await this.call('confirmAlert', { alertId, alertType });
  }
  async snoozeAlert(alertId: number, alertType: string): Promise<void> {
    await this.call('snoozeAlert', { alertId, alertType });
  }
  async getRequestOutcome(requestId: string): Promise<RequestOutcome> {
    return parseRequestOutcome(await this.call('getRequestOutcome', { requestId }));
  }
  async pumpPairingStatus(): Promise<PumpPairingStatus> {
    return this.decode('pumpPairingStatus', await this.call('pumpPairingStatus'), parsePumpPairingStatus);
  }
}
