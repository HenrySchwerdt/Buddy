/**
 * Protocol simulator of a Medtronic MiniMed pump behind a RileyLink, for tests (original work;
 * the message layouts follow MinimedKit, migrated from ps2/rileylink_ios, MIT License,
 * (c) LoopKit Authors). It wires, by composition:
 *
 *   driver -> MinimedSession -> RileyLinkDevice -> fake BLE -> RileyLinkSimulator
 *          -> MinimedPumpSimulator (radio packets, wake-up, two-step commands) -> pump behaviour
 *
 * The pump sleeps until it gets a power-on message, answers the one byte "short" message of a
 * command with an ack and only then takes the arguments, delivers boluses at the pump's real speed
 * (from the injected clock), keeps a history page the driver can read and cancels a running bolus
 * when suspended. Fault injection: lost acknowledgements, a silent pump, rejected commands, a
 * sleeping pump, a percent temp basal.
 *
 * Bench scenario only: nothing is ever delivered, this is arithmetic.
 */
import { concatBytes, fromHex, type Bytes, type Millis } from '@buddy/core';
import { RileyLinkSimulator } from '../rileylink';
import { encodeBasalSchedule, type BasalSchedule } from './basal-schedule';
import { computeCrc16 } from './history/crc16';
import { encodePumpEventTimestamp, HISTORY_PAGE_LENGTH, millisToPumpClock, pumpClockToMillis } from './history/events';
import { LONG_BODY_LENGTH, PumpErrorCode, padTo } from './messages/bodies';
import { MessageType, PacketType } from './messages/message-type';
import { encodePumpMessage } from './messages/pump-message';
import { bolusDeliveryTimeMs, estimateBolusProgress, insulinBitPackingScale, isLargerModel, type PumpModel } from './models';
import { decodeMinimedPacket, encodeMinimedPacket } from './radio/packet';

export interface MinimedPumpSimulatorOptions {
  /** the clock of the world: bolus delivery, temp basal and the pump's own clock follow it */
  readonly clock: { now(): Millis };
  /** 6 digits */
  readonly serial?: string;
  readonly model?: PumpModel;
  /** the zone the pump's wall clock is kept in */
  readonly utcOffsetSeconds?: number;
  /** how far the pump's clock is off the world's */
  readonly clockSkewMs?: number;
  readonly initialReservoirUnits?: number;
  readonly batteryVolts?: number;
  readonly maxBolus?: number;
  readonly maxBasal?: number;
  /** U/h in 30 minute steps from midnight (default: 0.8 U/h all day) */
  readonly basalSchedule?: BasalSchedule;
  /** the pump never goes to sleep (default: false, it must be woken) */
  readonly alwaysAwake?: boolean;
}

export interface ReceivedCommand {
  readonly messageType: number;
  /** the message carried the one byte short body (opening a command) */
  readonly short: boolean;
  readonly at: Millis;
}

interface ActiveBolus {
  readonly programmed: number;
  readonly startedAt: Millis;
  readonly byPumpUi: boolean;
}

interface ActiveTemp {
  readonly rate: number;
  readonly startedAt: Millis;
  readonly durationMin: number;
}

const ackBody = (): Bytes => Uint8Array.of(0);
const MIN = 60_000;

export class MinimedPumpSimulator {
  readonly model: PumpModel;
  /** every message the pump received, in order */
  readonly received: ReceivedCommand[] = [];
  /** commands the pump executed (arguments accepted) */
  executed = 0;

  private readonly clock: { now(): Millis };
  private readonly address: Bytes;
  private readonly utcOffsetSeconds: number;
  private clockSkewMs: number;
  private reservoir: number;
  private readonly batteryVolts: number;
  private readonly maxBolus: number;
  private readonly maxBasal: number;
  private readonly basal: BasalSchedule;
  private readonly alwaysAwake: boolean;

  private awakeUntil = 0;
  private suspended = false;
  private bolus: ActiveBolus | null = null;
  private temp: ActiveTemp | null = null;
  private percentTemp = false;
  private deliveredUser = 0;
  private events: Bytes[] = [];
  /** message type of a command opened by its short message, waiting for the arguments */
  private opened: number | null = null;
  private frames: { type: number; data: Bytes; next: number } | null = null;

  private silent = false;
  private lostAcks = 0;
  private lostCommands = 0;
  private dropArguments = false;
  private silentAfterCommand = false;
  private silentOnArguments = false;
  private rejection: number | null = null;

  constructor(o: MinimedPumpSimulatorOptions) {
    this.clock = o.clock;
    this.model = o.model ?? '723';
    this.address = fromHex(o.serial ?? '123456');
    this.utcOffsetSeconds = o.utcOffsetSeconds ?? 3600;
    this.clockSkewMs = o.clockSkewMs ?? 0;
    this.reservoir = o.initialReservoirUnits ?? 150;
    this.batteryVolts = o.batteryVolts ?? 1.4;
    this.maxBolus = o.maxBolus ?? 10;
    this.maxBasal = o.maxBasal ?? 5;
    this.basal = o.basalSchedule ?? { entries: [{ index: 0, startMinute: 0, rate: 0.8 }] };
    this.alwaysAwake = o.alwaysAwake ?? false;
  }

  // ── test controls ───────────────────────────────────────────────────────────

  /** The pump hears nothing: every request goes unanswered (until switched off). */
  setSilent(on: boolean): void {
    this.silent = on;
  }

  /** The pump executes the next `n` commands but their acknowledgements never reach the controller. */
  loseNextAcks(n: number): void {
    this.lostAcks = n;
  }

  /** The arguments of the next `n` commands never reach the pump (every radio retry is lost): it opens them but does not execute them. */
  loseNextCommands(n: number): void {
    this.lostCommands = n;
  }

  /** The pump goes deaf right after it executed the next command (and its acknowledgement is lost). */
  goSilentAfterNextCommand(): void {
    this.silentAfterCommand = true;
    this.lostAcks = Math.max(this.lostAcks, 1);
  }

  /** The pump goes deaf the moment the arguments of the next command arrive: it does not execute them and does not answer anything afterwards. */
  goSilentWhenArgumentsArrive(): void {
    this.silentOnArguments = true;
  }

  /** The user suspends the pump with its buttons. */
  suspendAtPump(): void {
    this.sync();
    this.finishRunningBolus();
    this.suspended = true;
    this.temp = null;
    this.events.push(this.simpleRecord(0x1e, this.clock.now()));
  }

  /** The pump answers the next command's arguments with an error code and does not execute it. */
  rejectNext(errorCode: number): void {
    this.rejection = errorCode;
  }

  /** The pump goes back to sleep: it answers only power-on messages until woken. */
  sleep(): void {
    this.awakeUntil = 0;
  }

  /** The pump runs its temp basal as a percentage (it refuses temp basal commands in units per hour). */
  setPercentTempBasal(on: boolean): void {
    this.percentTemp = on;
    this.temp = on ? { rate: 150, startedAt: this.clock.now(), durationMin: 60 } : null;
  }

  /** The user starts a bolus with the pump's buttons. */
  pumpUiBolus(units: number): void {
    this.sync();
    this.bolus = { programmed: units, startedAt: this.clock.now(), byPumpUi: true };
  }

  /** The pump's clock now shows the world's time plus `ms`. */
  setClockSkew(ms: number): void {
    this.clockSkewMs = ms;
  }

  // ── ground truth ────────────────────────────────────────────────────────────

  /** Units of boluses the pump delivered (the running one counted up to now). */
  get deliveredBolusUnits(): number {
    this.sync();
    const b = this.bolus;
    return this.deliveredUser + (b ? this.deliveredOf(b) : 0);
  }

  get isSuspended(): boolean {
    this.sync();
    return this.suspended;
  }

  get isBolusing(): boolean {
    this.sync();
    return this.bolus !== null;
  }

  get reservoirUnits(): number {
    this.sync();
    return this.reservoir;
  }

  /** The temp basal the pump runs now, or null. */
  get tempBasal(): { rate: number; remainingMin: number } | null {
    this.sync();
    const t = this.temp;
    return t && !this.percentTemp ? { rate: t.rate, remainingMin: Math.max(0, Math.ceil((t.startedAt + t.durationMin * MIN - this.clock.now()) / MIN)) } : null;
  }

  /** The pump's wall clock, as milliseconds since the epoch of its own zone. */
  get pumpMillis(): Millis {
    return this.clock.now() + this.clockSkewMs;
  }

  // ── time-driven behaviour ───────────────────────────────────────────────────

  private deliveredOf(b: ActiveBolus): number {
    return estimateBolusProgress(this.model, this.clock.now() - b.startedAt, b.programmed).deliveredUnits;
  }

  /** Advances the pump to the clock: a bolus that ran its time is delivered and recorded, a temp basal that ended is gone. */
  private sync(): void {
    const now = this.clock.now();
    const b = this.bolus;
    if (b && now >= b.startedAt + bolusDeliveryTimeMs(this.model, b.programmed)) this.finishBolus(b.programmed);
    const t = this.temp;
    if (t && !this.percentTemp && now >= t.startedAt + t.durationMin * MIN) this.temp = null;
  }

  /** A suspend stops a bolus: what was delivered so far is recorded. */
  private finishRunningBolus(): void {
    const b = this.bolus;
    if (b) this.finishBolus(Math.min(b.programmed, this.deliveredOf(b)));
  }

  private finishBolus(delivered: number): void {
    const b = this.bolus;
    if (!b) return;
    this.bolus = null;
    this.deliveredUser += delivered;
    this.reservoir = Math.max(0, this.reservoir - delivered);
    this.events.push(this.bolusRecord(b, delivered));
  }

  // ── history records ─────────────────────────────────────────────────────────

  private stamp(at: Millis): Bytes {
    return encodePumpEventTimestamp(millisToPumpClock(at + this.clockSkewMs, this.utcOffsetSeconds));
  }

  private bolusRecord(b: ActiveBolus, delivered: number): Bytes {
    const scale = insulinBitPackingScale(this.model);
    const strokes = (units: number): number => Math.round(units * scale);
    if (isLargerModel(this.model)) {
      const p = strokes(b.programmed);
      const d = strokes(delivered);
      return concatBytes(Uint8Array.of(0x01, p >> 8, p & 0xff, d >> 8, d & 0xff, 0, 0, 0), this.stamp(b.startedAt));
    }
    return concatBytes(Uint8Array.of(0x01, strokes(b.programmed), strokes(delivered), 0), this.stamp(b.startedAt));
  }

  private simpleRecord(type: number, at: Millis): Bytes {
    return concatBytes(Uint8Array.of(type, 0x20), this.stamp(at));
  }

  private tempBasalRecords(rate: number, durationMin: number, at: Millis): Bytes[] {
    const strokes = Math.round(rate * 40);
    return [
      concatBytes(Uint8Array.of(0x33, strokes & 0xff), this.stamp(at), Uint8Array.of((strokes >> 8) & 0b111)),
      concatBytes(Uint8Array.of(0x16, Math.floor(durationMin / 30)), this.stamp(at)),
    ];
  }

  /** One history page: the newest events that fit, oldest first, zero padded, closed by the CRC. */
  private historyPage(): Bytes {
    const kept: Bytes[] = [];
    let size = 0;
    for (const e of [...this.events].reverse()) {
      if (size + e.length > HISTORY_PAGE_LENGTH - 2) break;
      kept.unshift(e);
      size += e.length;
    }
    const page = new Uint8Array(HISTORY_PAGE_LENGTH);
    let o = 0;
    for (const e of kept) {
      page.set(e, o);
      o += e.length;
    }
    const crc = computeCrc16(page.subarray(0, HISTORY_PAGE_LENGTH - 2));
    page[HISTORY_PAGE_LENGTH - 2] = crc >> 8;
    page[HISTORY_PAGE_LENGTH - 1] = crc & 0xff;
    return page;
  }

  // ── radio ───────────────────────────────────────────────────────────────────

  /** What the pump answers to a radio packet (null = silence). Plug into `RileyLinkSimulator.onRadio`. */
  respond = (tx: Bytes | null): Bytes | null => {
    if (!tx || this.silent) return null;
    const msg = decodeMinimedPacket(tx);
    if (!msg || msg.length < 5 || msg[0] !== PacketType.carelink) return null;
    if (!this.address.every((b, i) => msg[1 + i] === b)) return null;
    const type = msg[4]!;
    const body = msg.subarray(5);
    const short = body.length === 1;
    const now = this.clock.now();
    this.received.push({ messageType: type, short, at: now });
    this.sync();

    if (type === MessageType.powerOn) {
      if (!short) this.awakeUntil = now + (body[2] ?? 1) * MIN;
      return this.reply(MessageType.pumpAck, ackBody());
    }
    if (!this.alwaysAwake && now >= this.awakeUntil) return null; // asleep

    const answer = this.handle(type, body, short);
    return answer === null ? null : encodeMinimedPacket(encodePumpMessage({ packetType: PacketType.carelink, address: this.address, messageType: answer.type, body: { kind: 'raw', txData: answer.body } }));
  };

  private reply(type: number, body: Bytes): Bytes {
    return encodeMinimedPacket(encodePumpMessage({ packetType: PacketType.carelink, address: this.address, messageType: type, body: { kind: 'raw', txData: body } }));
  }

  private handle(type: number, body: Bytes, short: boolean): { type: number; body: Bytes } | null {
    const long = (t: number, ...b: number[]) => ({ type: t, body: padTo(Uint8Array.from(b), LONG_BODY_LENGTH) });
    const ack = { type: MessageType.pumpAck, body: ackBody() };
    const error = (code: number) => ({ type: MessageType.errorResponse, body: Uint8Array.of(code) });
    const scale = insulinBitPackingScale(this.model);

    switch (type) {
      case MessageType.pumpAck: {
        // the controller acknowledges a frame: send the next one
        const f = this.frames;
        return f ? this.nextFrame(f) : null;
      }
      case MessageType.getPumpModel:
        return long(type, 0x09, 0x03, ...Array.from(this.model, (c) => c.charCodeAt(0)));
      case MessageType.readFirmwareVersion:
        return long(type, 0x05, ...Array.from('VER 2.4A1.1', (c) => c.charCodeAt(0)));
      case MessageType.getBattery: {
        const v = Math.round(this.batteryVolts * 100);
        return long(type, 0x03, 0, v >> 8, v & 0xff);
      }
      case MessageType.readPumpStatus:
        return long(type, 0x03, 0x03, this.bolus ? 1 : 0, this.suspended ? 1 : 0);
      case MessageType.readRemainingInsulin: {
        const strokes = Math.round(this.reservoir * scale);
        return scale > 10 ? long(type, 0x04, 0, 0, strokes >> 8, strokes & 0xff) : long(type, 0x02, strokes >> 8, strokes & 0xff);
      }
      case MessageType.readSettings: {
        const bolus = Math.round(this.maxBolus * 10);
        const basal = Math.round(this.maxBasal * 40);
        const b = new Uint8Array(LONG_BODY_LENGTH);
        if (scale > 10) {
          b[0] = 25;
          b[7] = bolus;
          b[8] = basal >> 8;
          b[9] = basal & 0xff;
        } else {
          b[0] = 21;
          b[6] = bolus;
          b[7] = basal >> 8;
          b[8] = basal & 0xff;
        }
        b[18] = 4;
        return { type, body: b };
      }
      case MessageType.readTime: {
        const c = millisToPumpClock(this.pumpMillis, this.utcOffsetSeconds);
        return long(type, 0x07, c.hour, c.minute, c.second, c.year >> 8, c.year & 0xff, c.month, c.day);
      }
      case MessageType.readTempBasal: {
        const t = this.temp;
        if (!t) return long(type, 0x06, 0, 0, 0, 0, 0, 0);
        const remaining = Math.max(0, Math.ceil((t.startedAt + t.durationMin * MIN - this.clock.now()) / MIN));
        if (this.percentTemp) return long(type, 0x06, 1, t.rate, 0, 0, remaining >> 8, remaining & 0xff);
        const strokes = Math.round(t.rate * 40);
        return long(type, 0x06, 0, 0, strokes >> 8, strokes & 0xff, remaining >> 8, remaining & 0xff);
      }
      case MessageType.readProfileStd512:
        return this.startFrames(type, encodeBasalSchedule(this.basal));
      case MessageType.getHistoryPage:
        if (short) return this.openCommand(type, ack);
        return this.pageRequest(body[1] ?? 0, error);
      case MessageType.bolus:
      case MessageType.changeTempBasal:
      case MessageType.suspendResume:
      case MessageType.changeTime:
        return short ? this.openCommand(type, ack) : this.execute(type, body, ack, error);
      default:
        return null;
    }
  }

  private openCommand(type: number, ack: { type: number; body: Bytes }): { type: number; body: Bytes } {
    this.opened = type;
    this.dropArguments = this.lostCommands > 0;
    if (this.dropArguments) this.lostCommands -= 1;
    return ack;
  }

  private pageRequest(page: number, error: (code: number) => { type: number; body: Bytes }): { type: number; body: Bytes } {
    if (this.opened !== MessageType.getHistoryPage) return error(PumpErrorCode.commandRefused);
    this.opened = null;
    if (page !== 0) return error(PumpErrorCode.pageDoesNotExist);
    return this.startFrames(MessageType.getHistoryPage, this.historyPage());
  }

  private startFrames(type: number, data: Bytes): { type: number; body: Bytes } {
    const f = { type, data, next: 0 };
    this.frames = f;
    return this.nextFrame(f);
  }

  private nextFrame(f: { type: number; data: Bytes; next: number }): { type: number; body: Bytes } {
    const size = 64;
    const total = Math.ceil(f.data.length / size);
    const n = f.next;
    f.next += 1;
    const last = f.next >= total;
    if (last) this.frames = null;
    const chunk = f.data.subarray(n * size, (n + 1) * size);
    return { type: f.type, body: padTo(concatBytes(Uint8Array.of((n + 1) | (last ? 0x80 : 0)), chunk), LONG_BODY_LENGTH) };
  }

  /** The arguments of an opened command arrived. */
  private execute(type: number, body: Bytes, ack: { type: number; body: Bytes }, error: (code: number) => { type: number; body: Bytes }): { type: number; body: Bytes } | null {
    if (this.opened !== type) return null; // arguments without the short message: ignored
    if (this.silentOnArguments) {
      this.silentOnArguments = false;
      this.silent = true;
      return null;
    }
    if (this.dropArguments) return null; // never heard: the command stays open, nothing runs
    this.opened = null;
    if (this.rejection !== null) {
      const code = this.rejection;
      this.rejection = null;
      return error(code);
    }
    const refusal = this.run(type, body);
    if (refusal !== null) return error(refusal);
    this.executed += 1;
    if (this.silentAfterCommand) {
      this.silentAfterCommand = false;
      this.silent = true;
    }
    if (this.lostAcks > 0) {
      this.lostAcks -= 1;
      return null;
    }
    return ack;
  }

  /** Executes a command; returns an error code when the pump refuses it. */
  private run(type: number, body: Bytes): number | null {
    const now = this.clock.now();
    switch (type) {
      case MessageType.bolus: {
        const strokes = body[0] === 2 ? (body[1]! << 8) | body[2]! : body[1]!;
        const units = strokes / insulinBitPackingScale(this.model);
        if (this.suspended) return PumpErrorCode.commandRefused;
        if (this.bolus) return PumpErrorCode.bolusInProgress;
        if (units > this.maxBolus + 1e-9) return PumpErrorCode.maxSettingExceeded;
        this.bolus = { programmed: units, startedAt: now, byPumpUi: false };
        return null;
      }
      case MessageType.changeTempBasal: {
        const rate = ((body[1]! << 8) | body[2]!) / 40;
        const segments = body[3]!;
        if (this.suspended || this.percentTemp) return PumpErrorCode.commandRefused;
        if (rate > this.maxBasal + 1e-9) return PumpErrorCode.maxSettingExceeded;
        this.temp = segments === 0 ? null : { rate, startedAt: now, durationMin: segments * 30 };
        this.events.push(...this.tempBasalRecords(rate, segments * 30, now));
        return null;
      }
      case MessageType.suspendResume: {
        if (body[1] === 1) {
          this.finishRunningBolus();
          this.suspended = true;
          this.temp = null;
          this.events.push(this.simpleRecord(0x1e, now));
        } else {
          this.suspended = false;
          this.events.push(this.simpleRecord(0x1f, now));
        }
        return null;
      }
      case MessageType.changeTime: {
        const year = (body[4]! << 8) | body[5]!;
        const target = pumpClockToMillis({ hour: body[1]!, minute: body[2]!, second: body[3]!, year, month: body[6]!, day: body[7]! }, this.utcOffsetSeconds);
        this.events.push(this.simpleRecord(0x17, now));
        this.clockSkewMs = target - now;
        this.events.push(this.simpleRecord(0x18, now));
        return null;
      }
      default:
        return PumpErrorCode.commandRefused;
    }
  }
}

export interface MinimedPumpBenchOptions extends MinimedPumpSimulatorOptions {
  /** BLE id of the simulated RileyLink. */
  readonly rileyLinkId?: string;
  readonly rileyLinkName?: string;
}

/** A simulated pump with its RileyLink: add `rileyLink` to the fake BLE central. */
export class MinimedPumpBench {
  readonly pump: MinimedPumpSimulator;
  readonly rileyLink: RileyLinkSimulator;

  constructor(o: MinimedPumpBenchOptions) {
    this.pump = new MinimedPumpSimulator(o);
    this.rileyLink = new RileyLinkSimulator({ id: o.rileyLinkId ?? 'sim-rileylink-minimed', name: o.rileyLinkName ?? 'RileyLink', onRadio: this.pump.respond });
  }

  get deliveredBolusUnits(): number {
    return this.pump.deliveredBolusUnits;
  }
}
