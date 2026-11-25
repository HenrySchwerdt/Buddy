/**
 * Protocol simulator of a Dana-i (BLE5) / Dana RS (v3) pump for tests: the pump side of the
 * protocol implemented by the TypeScript port of loopandlearn/DanaKit (MIT, © 2021 Randall Knutson
 * and the DanaKit authors). It reuses the ported encryption (the pump runs the inverse direction
 * of the same algorithms) and answers the commands the driver uses.
 *
 * Behaviour that is *assumed* (DanaKit does not document the pump side) and must be checked on a
 * real pump: response payload layouts beyond what DanaKit parses, bolus delivery granularity, the
 * timestamp of a bolus history record (start time), that a bolus continues after the link drops.
 */
import { concatBytes, hex, type Bytes, type Millis } from '@buddy/core';
import type { FakePeripheral, PeripheralLink } from '../testkit/fake-ble';
import { DanaKitEncryption, encodePacketSerialNumber, encryptionRandomSyncKey, generateCrc } from './encryption';
import { DanaPacketType, EncryptionType } from './packet-type';
import { writeDate } from './packets/dates';
import { HistoryCode } from './packets/history';
import { DANA_CHUNK_SIZE, DANA_READ_CHAR, DANA_SERVICE } from './peripheral';

export interface DanaSimOptions {
  readonly id?: string;
  readonly deviceName: string;
  readonly model: 'dana-i' | 'dana-rs';
  readonly clock: { now(): Millis };
  /** 24 hourly basal rates, U/h. */
  readonly basalProfile?: readonly number[];
  readonly reservoir?: number;
  readonly maxBolus?: number;
  /** Dana-i: the 6 digit BLE5 key the pump hands out. */
  readonly ble5Key?: string;
  /** Dana RS: keys of an existing pairing (otherwise the first connect pairs with PINs). */
  readonly rsKeys?: { readonly pairingKey: Bytes; readonly randomPairingKey: Bytes };
}

interface SimBolus {
  readonly totalH: number;
  readonly startedAt: Millis;
  readonly spu: number;
  deliveredH: number;
}

interface HistoryRecord {
  readonly type: number;
  readonly at: Millis;
  readonly param8: number;
  readonly value: number;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const STEP_MS = 1_000;

export class DanaPumpSimulator implements FakePeripheral {
  readonly id: string;
  readonly name: string;
  readonly serviceUuids = [DANA_SERVICE];
  readonly mtu = 23;

  // Pump state
  basalProfile: number[];
  reservoir: number;
  battery = 80;
  suspended = false;
  temp: { percent: number; endsAt: Millis } | null = null;
  bolus: SimBolus | null = null;
  readonly history: HistoryRecord[] = [];
  private deliveredH = 0;
  /** The PINs the pump displays during RSv3 pairing (12 + 8 hex characters). */
  displayedPins: { pin1: string; pin2: string } | null = null;
  /** Every command opcode received (handshake excluded). */
  readonly commands: number[] = [];

  private rsKeys: { pairingKey: Bytes; randomPairingKey: Bytes } | null;
  private pendingPairing: { pairingKey: Bytes; randomPairingKey: Bytes } | null = null;
  private readonly ble5Key: Bytes;
  private readonly hwModel: number;
  private readonly bolusSpeedSpu = 12;

  // Session state (per connection)
  private link: PeripheralLink | null = null;
  private enc = new DanaKitEncryption();
  private secondLevel = false;
  private rx: number[] = [];
  private syncKeyEncrypted = 0;
  private dropAfterCommand: ((opCode: number) => boolean) | null = null;
  private silent: ((opCode: number) => boolean) | null = null;
  private lose: ((opCode: number) => boolean) | null = null;
  /** Fault injection: BLE writes never complete (a hung radio). */
  stallWrites = false;

  constructor(private readonly opts: DanaSimOptions) {
    this.id = opts.id ?? `dana-${opts.deviceName}`;
    this.name = opts.deviceName;
    this.basalProfile = [...(opts.basalProfile ?? Array.from({ length: 24 }, () => 1))];
    this.reservoir = opts.reservoir ?? 250;
    this.ble5Key = new Uint8Array(ascii(opts.ble5Key ?? '666866'));
    this.hwModel = opts.model === 'dana-i' ? 0x09 : 0x05;
    this.rsKeys = opts.rsKeys ? { pairingKey: opts.rsKeys.pairingKey.slice(), randomPairingKey: opts.rsKeys.randomPairingKey.slice() } : null;
  }

  private get mode(): number {
    return this.opts.model === 'dana-i' ? EncryptionType.BLE_5 : EncryptionType.RSv3;
  }
  private get usingUtc(): boolean {
    return this.hwModel >= 7;
  }

  /** Ground truth: units actually delivered as boluses. */
  deliveredBolusUnits(): number {
    return this.deliveredH / 100;
  }

  /** Drops the link right after the next command matching `filter` was executed (no response). */
  dropAfterNextCommand(filter: (opCode: number) => boolean = () => true): void {
    this.dropAfterCommand = filter;
  }

  /** The next matching command never reaches the pump: the link drops before it is executed. */
  loseNextCommand(filter: (opCode: number) => boolean): void {
    this.lose = filter;
  }

  /** Executes matching commands but never answers them (response lost). */
  swallowResponses(filter: ((opCode: number) => boolean) | null): void {
    this.silent = filter;
  }

  // ── FakePeripheral ──────────────────────────────────────────────────────────────

  onConnect(link: PeripheralLink): void {
    this.link = link;
    this.enc = new DanaKitEncryption();
    this.enc.setEnhancedEncryption(this.mode);
    this.secondLevel = false;
    this.rx = [];
  }

  onWrite(_service: string, _characteristic: string, data: Bytes, link: PeripheralLink): void | Promise<void> {
    if (this.stallWrites) return new Promise<void>(() => {});
    this.link = link;
    const plain = this.secondLevel ? this.enc.decodeSecondLevel(data) : data;
    this.rx.push(...plain);
    const len = this.rx[2];
    if (this.rx.length < 3 || len === undefined || this.rx.length < len + 7) return;
    const frame = new Uint8Array(this.rx.slice(0, len + 7));
    this.rx = this.rx.slice(len + 7);
    this.handleFrame(frame);
  }

  /** Advances the pump by `ms` (bolus delivery and its notifications). */
  advance(ms: number): void {
    const end = this.opts.clock.now();
    for (let t = end - ms + STEP_MS; t <= end; t += STEP_MS) this.tick(t);
    this.tick(end);
  }

  // ── Frames ──────────────────────────────────────────────────────────────────────

  private handleFrame(raw: Bytes): void {
    const frame = encodePacketSerialNumber(raw, this.opts.deviceName);
    const content = frame.slice(3, frame.length - 4);
    const type = content[0];
    const isEnc = type === DanaPacketType.TYPE_ENCRYPTION_REQUEST;
    const crc = generateCrc(content, this.mode, isEnc);
    if (crc >> 8 !== frame[frame.length - 4] || (crc & 0xff) !== frame[frame.length - 3]) {
      throw new Error(`Dana simulator: CRC mismatch in ${hex(raw)}`);
    }
    const opCode = content[1] ?? -1;
    const payload = content.slice(2);
    if (isEnc) this.handleEncryption(opCode, payload);
    else if (type === DanaPacketType.TYPE_COMMAND) this.handleCommand(opCode, payload);
  }

  private send(type: number, opCode: number, payload: readonly number[]): void {
    const link = this.link;
    if (!link) return;
    const body = new Uint8Array([type, opCode, ...payload]);
    const crc = generateCrc(body, this.mode, type === DanaPacketType.TYPE_ENCRYPTION_RESPONSE);
    let frame = encodePacketSerialNumber(concatBytes(new Uint8Array([0xa5, 0xa5, body.length]), body, new Uint8Array([(crc >> 8) & 0xff, crc & 0xff, 0x5a, 0x5a])), this.opts.deviceName);
    if (this.secondLevel) frame = this.enc.encodeSecondLevel(frame);
    for (let i = 0; i < frame.length; i += DANA_CHUNK_SIZE) link.notify(DANA_SERVICE, DANA_READ_CHAR, frame.slice(i, i + DANA_CHUNK_SIZE));
  }

  private respond(opCode: number, payload: readonly number[]): void {
    this.send(DanaPacketType.TYPE_RESPONSE, opCode, payload);
  }

  private notify(opCode: number, payload: readonly number[]): void {
    this.send(DanaPacketType.TYPE_NOTIFY, opCode, payload);
  }

  // ── Handshake ───────────────────────────────────────────────────────────────────

  private handleEncryption(opCode: number, payload: Bytes): void {
    const R = DanaPacketType.TYPE_ENCRYPTION_RESPONSE;
    if (opCode === DanaPacketType.OPCODE_ENCRYPTION__PUMP_CHECK) {
      if (hex(payload) !== hex(new Uint8Array(ascii(this.opts.deviceName)))) {
        this.send(R, opCode, ascii('PUMP'));
        return;
      }
      if (this.mode === EncryptionType.BLE_5) {
        this.send(R, opCode, [...ascii('OK'), 0x4d, this.hwModel, 0x50, 18, ...this.ble5Key]);
        return;
      }
      const syncKey = Math.floor(Math.random() * 256);
      this.syncKeyEncrypted = this.rsKeys ? encryptionRandomSyncKey(syncKey, this.rsKeys.randomPairingKey) : syncKey;
      this.send(R, opCode, [...ascii('OK'), 0x4d, this.hwModel, 0x50, 12, this.syncKeyEncrypted]);
      return;
    }

    if (opCode === DanaPacketType.OPCODE_ENCRYPTION__TIME_INFORMATION) {
      if (this.mode === EncryptionType.BLE_5) {
        this.send(R, opCode, [0x00]);
        this.enc.setBle5Key(this.ble5Key);
        this.secondLevel = true;
        return;
      }
      if (payload[0] === 0x01) {
        // Pairing request: show fresh PINs
        const pairingKey = new Uint8Array(Array.from({ length: 6 }, () => Math.floor(Math.random() * 256)));
        const randomPairingKey = new Uint8Array(Array.from({ length: 3 }, () => Math.floor(Math.random() * 256)));
        const checksum = [...pairingKey, ...randomPairingKey].reduce((a, b) => a ^ b, 0);
        this.pendingPairing = { pairingKey, randomPairingKey };
        this.displayedPins = { pin1: hex(pairingKey), pin2: hex(concatBytes(randomPairingKey, new Uint8Array([checksum]))) };
        this.send(R, opCode, [0x00]);
        return;
      }
      if (this.pendingPairing) {
        // Paired in this session: DanaKit derives the sync key from the pairing key
        this.rsKeys = this.pendingPairing;
        this.pendingPairing = null;
        this.displayedPins = null;
        this.enc.setPairingKeys(this.rsKeys.pairingKey, this.rsKeys.randomPairingKey, null);
      } else if (this.rsKeys) {
        this.enc.setPairingKeys(this.rsKeys.pairingKey, this.rsKeys.randomPairingKey, this.syncKeyEncrypted);
      } else {
        this.send(R, opCode, [0x01]); // Error, no pairing
        return;
      }
      this.send(R, opCode, [0x00]);
      this.secondLevel = true;
    }
  }

  // ── Commands ────────────────────────────────────────────────────────────────────

  private handleCommand(opCode: number, p: Bytes): void {
    if (this.lose?.(opCode)) {
      this.lose = null;
      const link = this.link;
      this.link = null;
      link?.disconnect(new Error('Connection lost before the command arrived (simulated)'));
      return;
    }
    this.commands.push(opCode);
    const now = this.opts.clock.now();
    this.expireTemp(now);
    const reply = this.execute(opCode, p, now);

    const drop = this.dropAfterCommand;
    if (drop?.(opCode)) {
      this.dropAfterCommand = null;
      const link = this.link;
      this.link = null;
      link?.disconnect(new Error('Connection lost (simulated)'));
      return;
    }
    if (this.silent?.(opCode)) return;
    if (reply) reply();
  }

  /** Applies the command and returns the function that sends the answer. */
  private execute(opCode: number, p: Bytes, now: Millis): (() => void) | null {
    const T = DanaPacketType;
    const ok = () => this.respond(opCode, [0x00]);
    switch (opCode) {
      case T.OPCODE_ETC__KEEP_CONNECTION:
      case T.OPCODE_REVIEW__SET_HISTORY_UPLOAD_MODE:
      case T.OPCODE_OPTION__SET_PUMP_TIME:
      case T.OPCODE_OPTION__SET_PUMP_UTC_AND_TIME_ZONE:
        return ok;
      case T.OPCODE_REVIEW__INITIAL_SCREEN_INFORMATION:
        return () => this.respond(opCode, this.screen(now));
      case T.OPCODE_BASAL__GET_BASAL_RATE:
        return () => this.respond(opCode, [...le16(300), 1, ...this.basalProfile.flatMap((r) => le16(Math.round(r * 100)))]);
      case T.OPCODE_OPTION__GET_PUMP_UTC_AND_TIME_ZONE: {
        const d = new Uint8Array(6);
        writeDate(d, 0, now, true);
        const offset = Math.trunc(-new Date(now).getTimezoneOffset() / 60);
        return () => this.respond(opCode, [...d, offset & 0xff]);
      }
      case T.OPCODE_OPTION__GET_PUMP_TIME: {
        const d = new Uint8Array(6);
        writeDate(d, 0, now, false);
        return () => this.respond(opCode, [...d]);
      }
      case T.OPCODE_REVIEW__ALL_HISTORY:
      case T.OPCODE_REVIEW__BOLUS:
        return () => this.sendHistory(opCode, p);
      case T.OPCODE_BOLUS__SET_STEP_BOLUS_START:
        return this.startBolus(opCode, p, now);
      case T.OPCODE_BOLUS__SET_STEP_BOLUS_STOP: {
        const b = this.bolus;
        if (b) this.finishBolus(now);
        return () => {
          ok();
          if (b) this.notify(T.OPCODE_NOTIFY__DELIVERY_COMPLETE, le16(b.deliveredH));
        };
      }
      case T.OPCODE_BASAL__APS_SET_TEMPORARY_BASAL: {
        if (this.suspended) return () => this.respond(opCode, [0x01]);
        const percent = Math.min(500, (p[0] ?? 0) | ((p[1] ?? 0) << 8));
        const minutes = p[2] === 150 ? 15 : p[2] === 160 ? 30 : 0;
        if (!minutes) return () => this.respond(opCode, [0x01]);
        this.temp = { percent, endsAt: now + minutes * 60_000 };
        return ok;
      }
      case T.OPCODE_BASAL__SET_TEMPORARY_BASAL: {
        if (this.suspended || (p[0] ?? 0) > 200 || !p[1]) return () => this.respond(opCode, [0x01]);
        this.temp = { percent: p[0]!, endsAt: now + p[1]! * 3_600_000 };
        return ok;
      }
      case T.OPCODE_BASAL__CANCEL_TEMPORARY_BASAL:
        this.temp = null;
        return ok;
      case T.OPCODE_BASAL__SET_SUSPEND_ON:
        this.suspended = true;
        this.temp = null;
        this.history.push({ type: HistoryCode.RECORD_TYPE_SUSPEND, at: now, param8: 0x4f, value: 0 });
        return ok;
      case T.OPCODE_BASAL__SET_SUSPEND_OFF:
        this.suspended = false;
        this.history.push({ type: HistoryCode.RECORD_TYPE_SUSPEND, at: now, param8: 0x46, value: 0 });
        return ok;
      default:
        return () => this.respond(opCode, [0x01]);
    }
  }

  private screen(now: Millis): number[] {
    this.expireTemp(now);
    const status = (this.suspended ? 0x01 : 0) | (this.temp ? 0x10 : 0);
    const basalNow = this.basalProfile[new Date(now).getHours()] ?? 0;
    return [
      status,
      ...le16(0), // daily total
      ...le16(4000), // max daily
      ...le16(Math.round(this.reservoir * 100)),
      ...le16(Math.round(basalNow * 100)),
      this.temp ? Math.min(255, this.temp.percent) : 100,
      this.battery,
      ...le16(0), // extended remaining
      ...le16(0), // IOB
      0, // error state
    ];
  }

  private startBolus(opCode: number, p: Bytes, now: Millis): () => void {
    const totalH = (p[0] ?? 0) | ((p[1] ?? 0) << 8);
    const err = this.suspended ? 0x01 : this.bolus ? 0x04 : totalH > (this.opts.maxBolus ?? 10) * 100 ? 0x10 : p[2]! > 2 ? 0x40 : 0;
    if (err) return () => this.respond(opCode, [err]);
    this.bolus = { totalH, startedAt: now, spu: [12, 30, 60][p[2]!] ?? this.bolusSpeedSpu, deliveredH: 0 };
    return () => this.respond(opCode, [0x00]);
  }

  private tick(t: Millis): void {
    const b = this.bolus;
    if (!b) return;
    const due = Math.min(b.totalH, Math.floor(((t - b.startedAt) * 100) / (b.spu * 1000)));
    if (due <= b.deliveredH) return;
    this.deliveredH += due - b.deliveredH;
    this.reservoir = Math.max(0, this.reservoir - (due - b.deliveredH) / 100);
    b.deliveredH = due;
    if (due >= b.totalH) {
      this.finishBolus(t);
      this.notify(DanaPacketType.OPCODE_NOTIFY__DELIVERY_COMPLETE, le16(b.deliveredH));
    } else {
      this.notify(DanaPacketType.OPCODE_NOTIFY__DELIVERY_RATE_DISPLAY, le16(b.deliveredH));
    }
  }

  private finishBolus(at: Millis): void {
    const b = this.bolus;
    if (!b) return;
    this.bolus = null;
    // Bolus record: value = delivered hundredths (big endian), param8 0x80 = standard bolus
    this.history.push({ type: HistoryCode.RECORD_TYPE_BOLUS, at: b.startedAt, param8: 0x80, value: b.deliveredH });
    void at;
  }

  private sendHistory(opCode: number, p: Bytes): void {
    const from = p[0] === 0 && p[1] === 1 && p[2] === 1 ? 0 : this.readFrom(p);
    for (const r of this.history) {
      if (r.at < from) continue;
      const d = new Uint8Array(6);
      writeDate(d, 0, r.at, this.usingUtc);
      // [code, YY, MM, DD, hh, mm, ss, param8, value hi, value lo] — DanaKit reads the seconds byte as param7
      this.respond(opCode, [r.type, ...d, r.param8, (r.value >> 8) & 0xff, r.value & 0xff]);
    }
    this.respond(opCode, [0x00, 0x00, 0x00]);
  }

  private readFrom(p: Bytes): Millis {
    const c = Array.from(p.slice(0, 6));
    return this.usingUtc ? Date.UTC(2000 + c[0]!, c[1]! - 1, c[2]!, c[3]!, c[4]!, c[5]!) : new Date(2000 + c[0]!, c[1]! - 1, c[2]!, c[3]!, c[4]!, c[5]!).getTime();
  }

  private expireTemp(now: Millis): void {
    if (this.temp && now >= this.temp.endsAt) this.temp = null;
  }
}
