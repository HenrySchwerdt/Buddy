/**
 * Simulated InsightBridge for tests: the bridge side of PROTOCOL.md (BLE peripheral with the
 * handshake of section 4, the encrypted envelope of section 3, framing of section 2 and the
 * operations of section 5.1) in front of a small Accu-Chek Insight model (reservoir, hourly basal
 * profile, temp basal, bolus delivery over time, history with sequence numbers).
 *
 * It implements the bridge's contract rules that matter for dosing: idempotent `requestId`s with
 * `getRequestOutcome`, rejection (never clamping) of out-of-range values, `pumpSuspended` when the
 * pump is stopped, and a bolus that responds when it is *accepted*, not when it completed.
 * Fault injection covers lost responses, dropped links, uncertain errors and unreadable answers.
 *
 * Written from PROTOCOL.md; no code of the AGPL InsightBridge app is used.
 */
import type { Bytes } from '@buddy/core';
import type { FakePeripheral, PeripheralLink } from '../testkit';
import { base64Encode, secureRandom, utf8Decode, utf8Encode, type RandomSource } from './bytes';
import { BRIDGE_RX_UUID, BRIDGE_SERVICE_UUID, BRIDGE_TX_UUID, HISTORY_PAGE_SIZE, INSIGHT_PROTOCOL_VERSION } from './constants';
import {
  commitment,
  confirmationCode,
  confirmMacBridge,
  confirmMacPhone,
  DIRECTION_BRIDGE_TO_PHONE,
  ecdhSharedSecret,
  EnvelopeCodec,
  generatePairingKeyPair,
  isEncryptedEnvelope,
  longTermKey,
  sessionKey,
  sessionMac,
  verifyMac,
} from './crypto';
import { bolusStepForAmount, isMultiple, basalStepForRate } from './dosing-math';
import { decodeHandshake, encodeHandshake, handshakeBytes, type HandshakeMessage } from './handshake';
import { fragmentMessage, Reassembler } from './fragmentation';
import { formatBridgeDate, isObject, asInt, asNumber, asString, type JsonObject, type JsonValue } from './models';

export interface InsightSimOptions {
  readonly clock: { now(): number };
  /** Peripheral id on the (fake) BLE transport. */
  readonly id?: string;
  /** Hex id of the bridge (16 characters). */
  readonly bridgeId?: string;
  /** The phone that is already paired; `null` = nobody (pair first). */
  readonly paired?: { readonly ltk: Bytes; readonly clientId: string } | null;
  readonly serial?: string;
  readonly reservoir?: number;
  /** 24 hourly rates, U/h. */
  readonly basalProfile?: readonly number[];
  /** Pump local offset from UTC. */
  readonly utcOffsetSeconds?: number;
  readonly maxBolus?: number;
  readonly maxBasal?: number;
  /** Seconds the pump needs per unit of bolus. */
  readonly secondsPerUnit?: number;
  readonly mtu?: number;
  readonly random?: RandomSource;
  /** The Android user confirms the pairing code by itself (default true). */
  readonly autoConfirmAndroid?: boolean;
}

interface ActiveBolus {
  id: number;
  amount: number;
  delivered: number;
  startedAt: number;
  lastTick: number;
}
interface ActiveTbr {
  percent: number;
  duration: number;
  start: number;
}
interface HistoryRecord {
  seq: number;
  time: number;
  type: string;
  data: JsonObject;
}
interface Outcome {
  state: 'inProgress' | 'succeeded' | 'failed' | 'uncertain';
  result: JsonValue | null;
  error: JsonValue | null;
  completedAt: number | null;
}
interface PairingContext {
  commit: Bytes;
  keys: ReturnType<typeof generatePairingKeyPair>;
  nonceB: Bytes;
  ltk: Bytes | null;
  phoneConfirmed: boolean;
  androidConfirmed: boolean;
  clientId: string;
}
interface Conn {
  readonly reassembler: Reassembler;
  readonly seq: { value: number };
  codec: EnvelopeCodec | null;
  pairing: PairingContext | null;
}

export type SimError = { readonly code: string; readonly message?: string; readonly uncertain?: boolean };

const DOSING_OPS = new Set(['deliverBolus', 'cancelBolus', 'setTBR', 'cancelTBR', 'setOperatingMode', 'setBasalProfile']);

export class InsightBridgeSimulator implements FakePeripheral {
  readonly id: string;
  readonly name: string | null = null;
  readonly serviceUuids = [BRIDGE_SERVICE_UUID];
  readonly mtu: number;
  readonly bridgeId: string;

  // pump model
  mode: 'started' | 'stopped' = 'started';
  reservoir: number;
  battery = 80;
  basal: number[];
  tbr: ActiveTbr | null = null;
  bolus: ActiveBolus | null = null;
  readonly history: HistoryRecord[] = [];
  alert: JsonObject | null = null;
  pumpLink: 'connected' | 'disconnected' | 'notPaired' = 'connected';
  driftSeconds = 0;
  profileWrites = 0;
  readonly executed: { op: string; args: JsonObject }[] = [];

  private paired: { ltk: Bytes; clientId: string | null } | null;
  private readonly conns = new WeakMap<PeripheralLink, Conn>();
  private readonly links = new Set<PeripheralLink>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly random: RandomSource;
  private readonly clock: { now(): number };
  private readonly serial: string;
  private readonly utcOffset: number;
  private readonly maxBolus: number;
  private readonly maxBasal: number;
  private readonly secPerUnit: number;
  private readonly autoConfirm: boolean;
  private seq = 0;
  private nextBolusId = 1;
  private deliveredTotal = 0;
  private pairingOpen = false;
  private lastCode: string | null = null;
  private silent = 0;
  private injected: { error: SimError; executes: boolean } | null = null;
  private dropBeforeResponse = false;
  private corruptNext = false;
  private hideOutcomes = false;
  private pending: { conn: Conn; link: PeripheralLink } | null = null;

  constructor(options: InsightSimOptions) {
    this.clock = options.clock;
    this.id = options.id ?? 'insight-bridge-1';
    this.bridgeId = options.bridgeId ?? 'fedcba9876543210';
    this.paired = options.paired === undefined ? null : options.paired ? { ltk: options.paired.ltk, clientId: options.paired.clientId } : null;
    this.serial = options.serial ?? 'INS123456';
    this.reservoir = options.reservoir ?? 150;
    this.basal = [...(options.basalProfile ?? Array.from({ length: 24 }, () => 1))];
    this.utcOffset = options.utcOffsetSeconds ?? 3600;
    this.maxBolus = options.maxBolus ?? 10;
    this.maxBasal = options.maxBasal ?? 5;
    this.secPerUnit = options.secondsPerUnit ?? 40;
    this.mtu = options.mtu ?? 185;
    this.random = options.random ?? secureRandom;
    this.autoConfirm = options.autoConfirmAndroid ?? true;
  }

  // ── test controls ──────────────────────────────────────────────────────────

  /** The user tapped "Pair with iPhone" in the bridge app. */
  enterPairingMode(): void {
    this.pairingOpen = true;
  }
  /** The code shown on the Android phone for the running pairing. */
  get pairingCode(): string | null {
    return this.lastCode;
  }
  /** The Android user answers the pairing code. */
  confirmPairingOnAndroid(matches: boolean): void {
    const p = this.pending;
    if (!p?.conn.pairing) return;
    if (!matches) {
      this.sendHandshake(p.conn, p.link, { t: 'pairReject', reason: 'userRejected' });
      p.conn.pairing = null;
      this.pending = null;
      return;
    }
    p.conn.pairing.androidConfirmed = true;
    this.finishPairings();
  }
  get isPaired(): boolean {
    return this.paired !== null;
  }
  get pairedLtk(): Bytes | null {
    return this.paired?.ltk ?? null;
  }
  get pairedClientId(): string | null {
    return this.paired?.clientId ?? null;
  }
  /** The next `n` commands are executed but never answered (the phone sees a timeout). */
  loseNextResponses(n = 1): void {
    this.silent = n;
  }
  /** The next dosing command is executed and the link drops before the answer is sent. */
  dropAfterNextDosingCommand(): void {
    this.dropBeforeResponse = true;
  }
  /** The next dosing command answers with `error` (and is executed only if `executes`). */
  failNextDosing(error: SimError, executes = false): void {
    this.injected = { error, executes };
  }
  /** The next dosing command is answered with something unreadable (it is executed). */
  corruptNextDosingAnswer(): void {
    this.corruptNext = true;
  }
  /** `getRequestOutcome` answers `unknown` for everything (an older bridge). */
  setOutcomeUnknown(hide: boolean): void {
    this.hideOutcomes = hide;
  }
  /** Insulin the pump really delivered as boluses (ground truth). */
  deliveredBolusUnits(): number {
    this.tick();
    return Math.round((this.deliveredTotal + (this.bolus?.delivered ?? 0)) * 10000) / 10000;
  }
  advance(_ms: number): void {
    this.tick();
  }
  /** Raises an alert on the pump. */
  raiseAlert(alertId: number, alertType: string, category: string): void {
    this.alert = { alertId, alertType, category, status: 'active', tbrPercent: null, remainingInsulin: null };
    this.broadcast('alert', this.alert);
  }
  /** A temp basal programmed on the pump itself. */
  programTbrOnPump(percent: number, duration: number): void {
    this.tick();
    this.tbr = { percent, duration, start: this.now() };
    this.record('tbrStart', { percent, duration });
    this.broadcast('status', this.statusJson());
  }
  /** Ends the running temp basal on the pump itself. */
  endTbrOnPump(): void {
    this.tick();
    if (this.tbr) this.record('tbrEnd', { percent: this.tbr.percent, duration: Math.round((this.now() - this.tbr.start) / 60_000) });
    this.tbr = null;
  }
  /** A bolus programmed on the pump itself. */
  programBolusOnPump(amount: number): void {
    this.tick();
    this.startBolus(amount);
    this.broadcast('status', this.statusJson());
  }

  // ── pump model ─────────────────────────────────────────────────────────────

  private now(): number {
    return this.clock.now();
  }

  private record(type: string, data: JsonObject, time = this.now()): void {
    this.seq += 1;
    this.history.push({ seq: this.seq, time, type, data });
  }

  /** Moves the pump model to the current time. */
  private tick(): void {
    const now = this.now();
    const b = this.bolus;
    if (b) {
      const dt = Math.max(0, now - b.lastTick) / 1000;
      b.delivered = Math.min(b.amount, b.delivered + dt / this.secPerUnit);
      b.lastTick = now;
      if (b.delivered >= b.amount - 1e-9) this.finishBolus(now);
    }
    const t = this.tbr;
    if (t && now >= t.start + t.duration * 60_000) {
      this.record('tbrEnd', { percent: t.percent, duration: t.duration }, t.start + t.duration * 60_000);
      this.tbr = null;
    }
  }

  private finishBolus(at: number, stoppedAt?: number): void {
    const b = this.bolus;
    if (!b) return;
    this.deliveredTotal += b.delivered;
    this.reservoir = Math.max(0, this.reservoir - b.delivered);
    this.record('bolusDelivered', {
      bolusId: b.id,
      bolusType: 'standard',
      programmed: b.amount,
      delivered: Math.round(b.delivered * 1000) / 1000,
      start: formatBridgeDate(b.startedAt),
      end: formatBridgeDate(stoppedAt ?? at),
    });
    this.bolus = null;
  }

  private startBolus(amount: number): ActiveBolus {
    const now = this.now();
    const b: ActiveBolus = { id: this.nextBolusId++, amount, delivered: 0, startedAt: now, lastTick: now };
    this.bolus = b;
    this.record('bolusProgrammed', { bolusId: b.id, bolusType: 'standard', amount });
    return b;
  }

  private scheduledNow(): number {
    const hour = ((Math.floor((this.now() / 1000 + this.utcOffset) / 3600) % 24) + 24) % 24;
    return this.basal[hour]!;
  }

  private statusJson(): JsonObject {
    this.tick();
    const now = this.now();
    const local = new Date(now + this.utcOffset * 1000).toISOString().slice(0, 19);
    return {
      timestamp: formatBridgeDate(now),
      pumpLink: this.pumpLink,
      serial: this.serial,
      firmware: '3.1.0',
      operatingMode: this.mode,
      battery: { percent: this.battery },
      reservoir: { units: Math.round((this.reservoir - (this.bolus?.delivered ?? 0)) * 100) / 100, cartridgeType: 'prefilled' },
      basal: { activeProfile: 1, rate: this.scheduledNow() },
      tbr: this.tbr ? { percent: this.tbr.percent, duration: this.tbr.duration, remaining: Math.max(0, Math.round((this.tbr.start + this.tbr.duration * 60_000 - now) / 60_000)), start: formatBridgeDate(this.tbr.start) } : null,
      boluses: this.bolus ? [{ bolusId: this.bolus.id, type: 'standard', amount: this.bolus.amount, remaining: Math.round((this.bolus.amount - this.bolus.delivered) * 1000) / 1000 }] : [],
      pumpTime: { utc: formatBridgeDate(now + this.driftSeconds * 1000), pumpLocal: local, driftSeconds: this.driftSeconds },
      limits: { maxBolus: this.maxBolus, maxBasal: this.maxBasal, bolusStep: 0.05, basalStep: 0.01, minBasal: 0.02 },
      activeAlert: this.alert,
      lastHistorySequence: this.seq,
    };
  }

  // ── BLE peripheral ─────────────────────────────────────────────────────────

  onConnect(link: PeripheralLink): void {
    this.conns.set(link, { reassembler: new Reassembler(), seq: { value: 0 }, codec: null, pairing: null });
    this.links.add(link);
  }

  onWrite(_service: string, characteristic: string, data: Bytes, link: PeripheralLink): void {
    if (characteristic.toLowerCase() !== BRIDGE_RX_UUID) return;
    const conn = this.conns.get(link);
    if (!conn) return;
    const outcome = conn.reassembler.accept(data, this.now());
    if (outcome.kind !== 'complete') return;
    const envelope = outcome.message;
    if (isEncryptedEnvelope(envelope)) this.handleEncrypted(conn, link, envelope);
    else {
      const message = decodeHandshake(envelope);
      if (message) this.handleHandshake(conn, link, message);
    }
  }

  private sendRaw(conn: Conn, link: PeripheralLink, envelope: Bytes): void {
    conn.seq.value = (conn.seq.value + 1) & 0xffff;
    for (const f of fragmentMessage(envelope, conn.seq.value, Math.max(20, this.mtu - 3)) ?? []) link.notify(BRIDGE_SERVICE_UUID, BRIDGE_TX_UUID, f);
  }

  private sendHandshake(conn: Conn, link: PeripheralLink, message: HandshakeMessage): void {
    this.sendRaw(conn, link, encodeHandshake(message));
  }

  // ── handshake ──────────────────────────────────────────────────────────────

  private handleHandshake(conn: Conn, link: PeripheralLink, m: HandshakeMessage): void {
    switch (m.t) {
      case 'sessionStart':
        return this.sessionStart(conn, link, m);
      case 'pairStart':
        return this.pairStart(conn, link, m);
      case 'pairReveal':
        return this.pairReveal(conn, link, m);
      case 'pairConfirm':
        return this.pairConfirm(conn, link, m);
      case 'pairReject':
        conn.pairing = null;
        if (this.pending?.conn === conn) this.pending = null;
        return;
      default:
        return;
    }
  }

  private sessionStart(conn: Conn, link: PeripheralLink, m: HandshakeMessage): void {
    const clientId = asString(m.clientId);
    const nonceI = handshakeBytes(m, 'nonce', 16);
    const p = this.paired;
    if (!p || !nonceI || clientId === null || (p.clientId !== null && p.clientId !== clientId)) {
      this.sendHandshake(conn, link, { t: 'sessionReject', reason: 'unknownClient' });
      return;
    }
    p.clientId = clientId;
    const nonceB = this.random(16);
    conn.codec = new EnvelopeCodec(sessionKey(p.ltk, nonceI, nonceB), DIRECTION_BRIDGE_TO_PHONE);
    this.sendHandshake(conn, link, {
      t: 'sessionResp',
      v: INSIGHT_PROTOCOL_VERSION,
      bridgeId: this.bridgeId,
      nonce: base64Encode(nonceB),
      mac: base64Encode(sessionMac(p.ltk, nonceI, nonceB)),
    });
  }

  private pairStart(conn: Conn, link: PeripheralLink, m: HandshakeMessage): void {
    const commit = handshakeBytes(m, 'commit', 32);
    if (!this.pairingOpen || !commit) {
      this.sendHandshake(conn, link, { t: 'pairReject', reason: 'notInPairingMode' });
      return;
    }
    const keys = generatePairingKeyPair(this.random);
    const ctx: PairingContext = { commit, keys, nonceB: this.random(16), ltk: null, phoneConfirmed: false, androidConfirmed: false, clientId: '' };
    conn.pairing = ctx;
    this.sendHandshake(conn, link, { t: 'pairResp', v: INSIGHT_PROTOCOL_VERSION, pub: base64Encode(keys.publicKey), nonce: base64Encode(ctx.nonceB), bridgeId: this.bridgeId });
  }

  private pairReveal(conn: Conn, link: PeripheralLink, m: HandshakeMessage): void {
    const ctx = conn.pairing;
    const pub = handshakeBytes(m, 'pub', 65);
    const nonceI = handshakeBytes(m, 'nonce', 16);
    if (!ctx || !pub || !nonceI) return;
    if (!verifyMac(commitment(pub, nonceI), ctx.commit)) {
      this.sendHandshake(conn, link, { t: 'pairReject', reason: 'commitMismatch' });
      conn.pairing = null;
      return;
    }
    this.pairingOpen = false; // one pairing attempt per window
    ctx.ltk = longTermKey(ecdhSharedSecret(ctx.keys.privateKey, pub), nonceI, ctx.nonceB);
    this.lastCode = confirmationCode(ctx.ltk);
    if (this.autoConfirm) ctx.androidConfirmed = true;
    this.pending = { conn, link };
    this.finishPairings();
  }

  private pairConfirm(conn: Conn, _link: PeripheralLink, m: HandshakeMessage): void {
    const ctx = conn.pairing;
    const mac = handshakeBytes(m, 'mac');
    if (!ctx?.ltk || !mac || !verifyMac(mac, confirmMacPhone(ctx.ltk))) return;
    ctx.phoneConfirmed = true;
    this.finishPairings();
  }

  private finishPairings(): void {
    const p = this.pending;
    if (!p) return;
    const ctx = p.conn.pairing;
    if (!ctx?.ltk || !ctx.phoneConfirmed || !ctx.androidConfirmed) return;
    this.paired = { ltk: ctx.ltk, clientId: null };
    this.sendHandshake(p.conn, p.link, { t: 'pairDone', mac: base64Encode(confirmMacBridge(ctx.ltk)) });
    p.conn.pairing = null;
    this.pending = null;
  }

  // ── encrypted operations ───────────────────────────────────────────────────

  private respond(conn: Conn, link: PeripheralLink, body: JsonObject): void {
    if (!conn.codec) return;
    this.sendRaw(conn, link, conn.codec.seal(utf8Encode(JSON.stringify(body))));
  }

  /** Pushes an unsolicited event (section 5.5) to every open session. */
  private broadcast(name: string, data: JsonValue): void {
    for (const link of this.links) {
      const conn = this.conns.get(link);
      if (conn?.codec) this.respond(conn, link, { evt: name, data });
    }
  }

  private handleEncrypted(conn: Conn, link: PeripheralLink, envelope: Bytes): void {
    if (!conn.codec) return;
    let request: unknown;
    try {
      request = JSON.parse(utf8Decode(conn.codec.open(envelope)));
    } catch {
      link.disconnect(new Error('bad envelope'));
      return;
    }
    if (!isObject(request)) return;
    const id = asInt(request.id);
    const op = asString(request.op);
    const args = isObject(request.args) ? request.args : {};
    if (id === null || op === null) return;
    this.tick();

    const dosing = DOSING_OPS.has(op);
    const requestId = asString(args.requestId);
    // Idempotency: a repeated requestId returns the stored outcome without touching the pump.
    if (dosing && requestId !== null && op !== 'cancelBolus') {
      const known = this.outcomes.get(requestId);
      if (known && (known.state === 'succeeded' || known.state === 'failed')) {
        this.send(conn, link, id, known.state === 'succeeded' ? { ok: true, result: known.result ?? {} } : { ok: false, error: known.error });
        return;
      }
    }

    let result: { ok: true; result: JsonValue } | { ok: false; error: JsonObject };
    const injected = dosing ? this.injected : null;
    if (injected) this.injected = null;
    if (injected && !injected.executes) result = { ok: false, error: { code: injected.error.code, message: injected.error.message ?? 'injected', uncertain: injected.error.uncertain ?? false } };
    else {
      if (dosing && requestId !== null) this.outcomes.set(requestId, { state: 'inProgress', result: null, error: null, completedAt: null });
      result = this.execute(op, args);
      this.executed.push({ op, args });
      if (injected) result = { ok: false, error: { code: injected.error.code, message: injected.error.message ?? 'injected', uncertain: injected.error.uncertain ?? false } };
    }
    if (dosing && requestId !== null) {
      const uncertain = !result.ok && (result.error.uncertain === true);
      this.outcomes.set(requestId, {
        state: result.ok ? 'succeeded' : uncertain ? 'uncertain' : 'failed',
        result: result.ok ? result.result : null,
        error: result.ok ? null : result.error,
        completedAt: this.now(),
      });
      // An injected "uncertain" answer hides what really happened to the phone; the bridge keeps the truth only if it knows.
      if (injected?.executes && uncertain) this.outcomes.set(requestId, { state: 'uncertain', result: null, error: result.ok ? null : result.error, completedAt: this.now() });
    }

    if (dosing && this.dropBeforeResponse) {
      this.dropBeforeResponse = false;
      link.disconnect(new Error('Connection lost (simulated)'));
      return;
    }
    if (this.silent > 0) {
      this.silent -= 1;
      return;
    }
    if (dosing && this.corruptNext) {
      this.corruptNext = false;
      this.respond(conn, link, { id, ok: true, result: { garbage: true } });
      return;
    }
    this.send(conn, link, id, result);
  }

  private send(conn: Conn, link: PeripheralLink, id: number, body: { ok: true; result?: JsonValue } | { ok: false; error?: JsonValue }): void {
    this.respond(conn, link, { id, ...body } as JsonObject);
  }

  private err(code: string, message = '', uncertain = false): { ok: false; error: JsonObject } {
    return { ok: false, error: { code, message, uncertain } };
  }

  private execute(op: string, args: JsonObject): { ok: true; result: JsonValue } | { ok: false; error: JsonObject } {
    const ok = (result: JsonValue = {}) => ({ ok: true as const, result });
    switch (op) {
      case 'hello':
        return ok({ protocol: INSIGHT_PROTOCOL_VERSION, bridgeVersion: 'sim-1.0', pumpPaired: this.pumpLink !== 'notPaired' });
      case 'ping':
        return ok({ uptimeSeconds: 1, pumpLink: this.pumpLink, statusTimestamp: formatBridgeDate(this.now()) });
      case 'getStatus':
        return ok(this.statusJson());
      case 'pumpPairingStatus':
        return ok({ paired: this.pumpLink !== 'notPaired', serial: this.serial, bridgeBluetoothOn: true });
      case 'deliverBolus': {
        const amount = asNumber(args.amount);
        if (amount === null || amount <= 0) return this.err('invalidArgs', 'amount');
        if (amount > Math.min(this.maxBolus, 25) + 1e-9) return this.err('limitExceeded', 'amount');
        if (!isMultiple(amount, Math.max(0.05, bolusStepForAmount(amount)))) return this.err('invalidArgs', 'amount is not a multiple of the step');
        if (this.mode !== 'started') return this.err('pumpSuspended', 'The pump is suspended.');
        if (this.pumpLink !== 'connected') return this.err('pumpUnreachable', 'The pump is not reachable.');
        if (this.bolus) return this.err('pumpBusy', 'A bolus is running.');
        if (amount > this.reservoir) return this.err('limitExceeded', 'reservoir');
        const b = this.startBolus(amount);
        return ok({ bolusId: b.id, amount });
      }
      case 'cancelBolus': {
        const bolusId = asInt(args.bolusId);
        const b = this.bolus;
        if (!b || bolusId !== b.id) return this.err('invalidArgs', 'no such bolus');
        const delivered = Math.round(b.delivered * 1000) / 1000;
        this.finishBolus(this.now());
        return ok({ delivered });
      }
      case 'setTBR': {
        const percent = asInt(args.percent);
        const duration = asInt(args.duration);
        if (percent === null || duration === null || percent < 0 || percent > 250 || percent % 10 !== 0 || percent === 100) return this.err('invalidArgs', 'percent');
        if (duration < 15 || duration > 1440 || duration % 15 !== 0) return this.err('invalidArgs', 'duration');
        if (this.mode !== 'started') return this.err('pumpSuspended', 'The pump is suspended.');
        if (this.pumpLink !== 'connected') return this.err('pumpUnreachable', 'The pump is not reachable.');
        if (this.tbr) this.record('tbrEnd', { percent: this.tbr.percent, duration: Math.round((this.now() - this.tbr.start) / 60_000) });
        this.tbr = { percent, duration, start: this.now() };
        this.record('tbrStart', { percent, duration });
        return ok({ percent, duration });
      }
      case 'cancelTBR': {
        if (this.tbr) this.record('tbrEnd', { percent: this.tbr.percent, duration: Math.round((this.now() - this.tbr.start) / 60_000) });
        this.tbr = null;
        return ok({});
      }
      case 'setOperatingMode': {
        const mode = asString(args.mode);
        if (mode !== 'started' && mode !== 'stopped') return this.err('invalidArgs', 'mode');
        if (this.mode !== mode) this.record('operatingModeChanged', { oldMode: this.mode, newMode: mode });
        this.mode = mode;
        if (mode === 'stopped' && this.tbr) {
          this.record('tbrEnd', { percent: this.tbr.percent, duration: Math.round((this.now() - this.tbr.start) / 60_000) });
          this.tbr = null;
        }
        return ok({ mode });
      }
      case 'setBasalProfile': {
        const segments = Array.isArray(args.segments) ? args.segments : null;
        if (!segments || segments.length < 1 || segments.length > 24) return this.err('invalidArgs', 'segments');
        const rates: number[] = [];
        for (const s of segments) {
          if (!isObject(s)) return this.err('invalidArgs', 'segment');
          const duration = asInt(s.duration);
          const rate = asNumber(s.rate);
          if (duration === null || duration % 60 !== 0 || duration <= 0 || rate === null || rate < 0.02 || rate > this.maxBasal || !isMultiple(rate, basalStepForRate(rate))) return this.err('invalidArgs', 'segment');
          for (let i = 0; i < duration / 60; i++) rates.push(rate);
        }
        if (rates.length !== 24) return this.err('invalidArgs', 'segments must sum to 1440 minutes');
        this.basal = rates;
        this.profileWrites += 1;
        return ok({ activeProfile: 1 });
      }
      case 'setDateTime':
        this.driftSeconds = 0;
        return ok({});
      case 'readHistory': {
        const since = args.sinceSequence === null || args.sinceSequence === undefined ? null : asInt(args.sinceSequence);
        const max = Math.min(asInt(args.max) ?? HISTORY_PAGE_SIZE, 200);
        let events: HistoryRecord[];
        let more = false;
        if (since === null) events = this.history.slice(-max);
        else {
          const all = this.history.filter((h) => h.seq > since);
          events = all.slice(0, max);
          more = all.length > max;
        }
        return ok({
          events: events.map((h) => ({ seq: h.seq, time: formatBridgeDate(h.time), type: h.type, data: h.data })),
          lastSequence: events.length > 0 ? events[events.length - 1]!.seq : (since ?? this.seq),
          more,
        });
      }
      case 'confirmAlert':
        this.alert = null;
        return ok({});
      case 'snoozeAlert':
        if (this.alert) this.alert = { ...this.alert, status: 'snoozed' };
        return ok({});
      case 'getRequestOutcome': {
        const requestId = asString(args.requestId);
        const known = requestId !== null ? this.outcomes.get(requestId) : undefined;
        if (!known || this.hideOutcomes) return ok({ state: 'unknown', result: null, error: null, completedAt: null });
        return ok({ state: known.state, result: known.result, error: known.error, completedAt: known.completedAt === null ? null : formatBridgeDate(known.completedAt) });
      }
      default:
        return this.err('invalidArgs', 'unknown op');
    }
  }
}

