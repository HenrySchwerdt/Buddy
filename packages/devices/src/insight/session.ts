/**
 * Session layer (port of the session half of InsightKit `BridgeSession`): handshake (section 4.2),
 * envelope crypto (section 3), request/response correlation with timeouts, unsolicited events and
 * the liveness ping (section 1a.5) over one `BridgeChannel`.
 *
 * Invariants the dosing code relies on:
 * - A request that never left the phone fails with a *certain* error (`notConnected`, `encoding`).
 * - Once an envelope may have been (partly) written, every failure - timeout, link loss, a send
 *   error, a protocol violation - is reported as uncertain (`timeout` / `linkLost`), never as a
 *   clean rejection.
 * - Nothing in here logs keys, nonces, envelopes or message bodies.
 */
import { type Bytes, type Clock, type Logger } from '@buddy/core';
import { utf8Decode, utf8Encode, type RandomSource } from './bytes';
import type { BridgeChannel } from './ble-channel';
import type { InsightTimeouts } from './constants';
import { INSIGHT_PROTOCOL_VERSION } from './constants';
import type { InsightCredentials } from './credentials';
import { DIRECTION_PHONE_TO_BRIDGE, EnvelopeCodec, EnvelopeError, isEncryptedEnvelope, sessionKey, sessionMac, verifyMac } from './crypto';
import { decodeHandshake, encodeHandshake, handshakeBytes, sessionStartMessage, type HandshakeMessage } from './handshake';
import {
  asInt,
  BridgeError,
  isDosingOp,
  isObject,
  parseBridgeEvent,
  parseHello,
  parseRemoteError,
  type BridgeEvent,
  type BridgeOp,
  type HelloResult,
  type JsonObject,
  type JsonValue,
} from './models';


export type HandshakeFailure = 'silent' | 'rejected' | 'otherBridge' | 'macMismatch' | 'incompatible' | 'busy' | 'link' | 'protocol';

/** Why a candidate connection did not become a session. */
export class HandshakeError extends Error {
  constructor(
    readonly reason: HandshakeFailure,
    detail = '',
  ) {
    super(`Insight handshake failed (${reason}${detail ? `: ${detail}` : ''})`);
    this.name = 'HandshakeError';
  }
}

export interface SessionOptions {
  readonly clock: Clock;
  readonly log: Logger;
  readonly timeouts: InsightTimeouts;
  readonly random: RandomSource;
  /** Name sent in `hello`, e.g. "Buddy 1.0". */
  readonly appName: string;
}

interface Pending {
  readonly op: BridgeOp;
  readonly resolve: (v: JsonValue) => void;
  readonly reject: (e: BridgeError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const unref = (t: ReturnType<typeof setTimeout>) => (t as { unref?: () => void }).unref?.();

/**
 * Buffers plaintext handshake messages so none is lost between two awaits (the bridge may answer
 * faster than the phone gets around to listening). Encrypted envelopes are not expected yet.
 */
export class HandshakeInbox {
  private readonly queue: HandshakeMessage[] = [];
  private waiter: { resolve: (m: HandshakeMessage) => void; reject: (e: HandshakeError) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private closed = false;

  constructor(channel: BridgeChannel) {
    channel.setHandler((envelope) => {
      const message = decodeHandshake(envelope);
      if (!message) return;
      const w = this.waiter;
      if (w) {
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(message);
      } else this.queue.push(message);
    });
    channel.onClose(() => {
      this.closed = true;
      const w = this.waiter;
      this.waiter = null;
      if (w) {
        clearTimeout(w.timer);
        w.reject(new HandshakeError('link'));
      }
    });
  }

  /** The next handshake message; rejects with `silent` after `timeoutMs` and with `link` when the link closes. */
  next(timeoutMs: number): Promise<HandshakeMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new HandshakeError('link'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new HandshakeError('silent'));
      }, timeoutMs);
      unref(timer);
      this.waiter = { resolve, reject, timer };
    });
  }
}

export class InsightSession {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private inbound = 0;
  private pingMark = 0;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastExchange: number;
  private readonly eventListeners = new Set<(e: BridgeEvent) => void>();
  private readonly closeListeners = new Set<(e: BridgeError) => void>();

  private constructor(
    private readonly channel: BridgeChannel,
    private readonly codec: EnvelopeCodec,
    private readonly opts: SessionOptions,
    private helloResult: HelloResult | null,
  ) {
    this.lastExchange = opts.clock.now();
    channel.setHandler((e) => this.handleEnvelope(e));
    channel.onClose(() => this.teardown(new BridgeError('linkLost')));
  }

  get hello(): HelloResult | null {
    return this.helloResult;
  }
  get isOpen(): boolean {
    return !this.closed;
  }
  get peripheralId(): string {
    return this.channel.peripheralId;
  }

  onEvent(listener: (e: BridgeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClosed(listener: (e: BridgeError) => void): void {
    if (this.closed) listener(new BridgeError('linkLost'));
    else this.closeListeners.add(listener);
  }

  /**
   * Section 4.2: sessionStart, verify the bridge, derive the key, `hello`. Throws `HandshakeError`;
   * the channel is left open for the caller to close.
   */
  static async open(channel: BridgeChannel, creds: InsightCredentials, opts: SessionOptions): Promise<InsightSession> {
    const nonceI = opts.random(16);
    const inbox = new HandshakeInbox(channel);
    try {
      await channel.send(encodeHandshake(sessionStartMessage(creds.clientId, nonceI)));
    } catch {
      throw new HandshakeError('link', 'sessionStart');
    }
    const message = await inbox.next(opts.timeouts.handshakeMs);
    if (message.t === 'sessionReject') throw new HandshakeError('rejected', typeof message.reason === 'string' ? message.reason : 'rejected');
    if (message.t !== 'sessionResp') throw new HandshakeError('protocol', 'unexpected handshake message');

    const nonceB = handshakeBytes(message, 'nonce', 16);
    const mac = handshakeBytes(message, 'mac');
    if (!nonceB || !mac) throw new HandshakeError('protocol', 'sessionResp');
    if (typeof message.bridgeId === 'string' && message.bridgeId.toLowerCase() !== creds.bridgeId.toLowerCase()) throw new HandshakeError('otherBridge');
    if (!verifyMac(mac, sessionMac(creds.ltk, nonceI, nonceB))) throw new HandshakeError('macMismatch');

    const codec = new EnvelopeCodec(sessionKey(creds.ltk, nonceI, nonceB), DIRECTION_PHONE_TO_BRIDGE);
    const session = new InsightSession(channel, codec, opts, null);
    try {
      // First encrypted message: hello (the bridge drops the link if it does not arrive within 10 s).
      const result = await session.request('hello', { protocol: INSIGHT_PROTOCOL_VERSION, app: opts.appName }, opts.timeouts.handshakeMs);
      const hello = parseHello(result);
      if (!hello) throw new HandshakeError('protocol', 'hello');
      if (hello.protocolVersion !== INSIGHT_PROTOCOL_VERSION) throw new HandshakeError('incompatible');
      session.helloResult = hello;
    } catch (e) {
      session.teardown(new BridgeError('linkLost'), false);
      if (e instanceof HandshakeError) throw e;
      if (e instanceof BridgeError && e.kind === 'remote') {
        if (e.remoteCode === 'unsupportedProtocol') throw new HandshakeError('incompatible');
        if (e.remoteCode === 'busy') throw new HandshakeError('busy');
      }
      throw new HandshakeError('link', 'hello');
    }
    session.schedulePing();
    return session;
  }

  /** Sends `op`. Rejects with a `BridgeError`; see the class comment for what each kind means. */
  request(op: BridgeOp, args: JsonObject = {}, timeoutMs?: number): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new BridgeError('notConnected'));
    const id = this.nextId++;
    let envelope: Bytes;
    try {
      envelope = this.codec.seal(utf8Encode(JSON.stringify({ id, op, args })));
    } catch (e) {
      // Nothing left the phone.
      return Promise.reject(new BridgeError('encoding', null, e instanceof EnvelopeError ? e.fault : op));
    }
    const limit = timeoutMs ?? (op === 'ping' ? this.opts.timeouts.pingMs : isDosingOp(op) ? this.opts.timeouts.dosingMs : this.opts.timeouts.statusMs);
    return new Promise<JsonValue>((resolve, reject) => {
      const entry: Pending = { op, resolve, reject, timer: null };
      entry.timer = setTimeout(() => this.requestTimedOut(id), limit);
      unref(entry.timer);
      this.pending.set(id, entry);
      this.channel.send(envelope).catch(() => {
        // The envelope may or may not have arrived completely: treat as a lost link.
        this.opts.log.warn(`Insight: sending ${op} failed`);
        this.teardown(new BridgeError('linkLost'));
      });
    });
  }

  /** Drops the session; requests still waiting fail as "link lost" (their outcome is unknown). */
  async close(): Promise<void> {
    this.teardown(new BridgeError('linkLost'), false);
    await this.channel.close();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private requestTimedOut(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.opts.log.warn(`Insight: ${entry.op} timed out`);
    entry.reject(new BridgeError('timeout'));
    if (entry.op === 'ping') {
      // Anything received since the ping went out shows the link is alive; while a dosing request runs its own timeout decides.
      if (this.inbound !== this.pingMark) return;
      if ([...this.pending.values()].some((p) => isDosingOp(p.op))) return;
    }
    // The link may be half-open: drop it (the next command reconnects).
    this.teardown(new BridgeError('linkLost'));
  }

  private teardown(error: BridgeError, closeChannel = true): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
    const items = [...this.pending.values()];
    this.pending.clear();
    for (const p of items) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new BridgeError('linkLost'));
    }
    for (const l of [...this.closeListeners]) l(error);
    this.closeListeners.clear();
    if (closeChannel) void this.channel.close();
  }

  private handleEnvelope(envelope: Bytes): void {
    if (this.closed) return;
    if (!isEncryptedEnvelope(envelope)) {
      this.opts.log.info('Insight: ignoring a plaintext message inside a session');
      return;
    }
    let plain: Bytes;
    try {
      plain = this.codec.open(envelope);
    } catch (e) {
      // Replay or tampering: never process, drop the link.
      this.opts.log.error(`Insight: envelope rejected (${e instanceof EnvelopeError ? e.fault : 'error'})`);
      this.teardown(new BridgeError('protocolViolation', null, 'envelope'));
      return;
    }
    this.inbound += 1;
    this.lastExchange = this.opts.clock.now();
    let value: unknown;
    try {
      value = JSON.parse(utf8Decode(plain));
    } catch {
      this.opts.log.warn('Insight: undecodable message');
      return;
    }
    if (!isObject(value)) return;
    if (typeof value.evt === 'string') {
      const event = parseBridgeEvent(value.evt, value.data);
      if (!event) {
        this.opts.log.warn(`Insight: undecodable event ${value.evt}`);
        return;
      }
      for (const l of [...this.eventListeners]) l(event);
      return;
    }
    const id = asInt(value.id);
    if (id !== null && id >= 0) this.handleResponse(id, value);
    else if (value.error !== undefined) this.opts.log.warn('Insight: bridge error without a request id');
  }

  private handleResponse(id: number, value: JsonObject): void {
    const entry = this.pending.get(id);
    if (!entry) {
      this.opts.log.info('Insight: response for an unknown or expired request');
      return;
    }
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (value.ok === true) {
      entry.resolve(value.result === undefined || value.result === null ? {} : (value.result as JsonValue));
      return;
    }
    const remote = parseRemoteError(value.error);
    if (remote) entry.reject(new BridgeError('remote', remote));
    // A dosing answer we cannot read says nothing about what the pump did.
    else if (isDosingOp(entry.op)) entry.reject(BridgeError.remote('internal', 'unreadable response', true));
    else entry.reject(new BridgeError('protocolViolation', null, 'response'));
  }

  // ── liveness (section 1a.5) ────────────────────────────────────────────────

  private schedulePing(afterMs = this.opts.timeouts.pingIntervalMs): void {
    if (this.closed || this.opts.timeouts.pingIntervalMs <= 0) return;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      if (this.closed) return;
      // A running request proves liveness by its own answer or timeout: no ping on top of it.
      if (this.pending.size > 0) return this.schedulePing(10_000);
      this.pingMark = this.inbound;
      this.request('ping').then(
        () => this.schedulePing(),
        () => undefined, // a missing answer is handled by requestTimedOut
      );
    }, afterMs);
    unref(this.pingTimer);
  }

  /** Milliseconds since the last authenticated message (liveness across background wake-ups). */
  idleMs(): number {
    return this.opts.clock.now() - this.lastExchange;
  }
}
