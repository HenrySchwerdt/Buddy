/**
 * Protocol simulator of a RileyLink (BLE chip + subg_rfspy radio firmware) for tests. It implements
 * the wire protocol that `RileyLinkBLEKit` speaks (see `Command.swift`/`Response.swift`) as a
 * `FakePeripheral`, so `RileyLinkDevice` runs unmodified against it. Original work; the byte layouts
 * follow RileyLinkKit (MIT License, (c) Pete Schwamb).
 */
import { concatBytes, type Bytes } from '@buddy/core';
import type { FakePeripheral, PeripheralLink } from '../testkit/fake-ble';
import { asciiToString, stringToBytes } from './bytes';
import {
  CC111XRegister,
  CMD,
  RILEYLINK_BATTERY_SERVICE_UUID,
  RILEYLINK_SERVICE_UUID,
  RL_BATTERY_LEVEL_CHAR,
  RL_CHAR,
  ResponseCode,
} from './constants';
import { parseBleFirmware, parseRadioFirmware, radioCapabilities, responseFraming } from './firmware';
import { encodeRfPacket } from './rf-packet';

/**
 * What the simulated air interface does with an outgoing packet (`null` = a listen-only request).
 * Return the raw packet bytes heard in reply, or null for silence. Called once per radio attempt.
 */
export type RadioResponder = (tx: Bytes | null) => Bytes | null | Promise<Bytes | null>;

export interface RileyLinkSimulatorOptions {
  readonly id?: string;
  readonly name?: string;
  readonly bleFirmware?: string;
  readonly radioFirmware?: string;
  readonly batteryPercent?: number;
  readonly rssi?: number;
  readonly onRadio?: RadioResponder;
}

export interface RecordedCommand {
  readonly code: number;
  readonly payload: Bytes;
}

const REGISTER_ADDRESSES: ReadonlySet<number> = new Set(Object.values(CC111XRegister));
const u8 = (...b: number[]): Bytes => new Uint8Array(b);

export class RileyLinkSimulator implements FakePeripheral {
  readonly id: string;
  readonly name: string | null;
  readonly serviceUuids = [RILEYLINK_SERVICE_UUID];
  private readonly bleFirmware: string;
  private readonly radioFirmware: string;
  private readonly framing;
  private readonly caps;
  private readonly rssi: number;
  private battery: number;
  private responder: RadioResponder;
  private link: PeripheralLink | null = null;
  private responses: Bytes[] = [];
  private responseCount = 0;
  private packetCounter = 0;
  private swallow = false;
  private interruptNext = false;

  /** Every command received, in order (excluding length prefix). */
  readonly commands: RecordedCommand[] = [];
  readonly registers = new Map<number, number>();
  readonly modeRegisters = new Map<number, readonly number[]>();
  softwareEncoding = 0;
  preamble = 0;
  customName: string | null = null;
  diagnosticLed = 0;
  readonly radioLeds = new Map<number, number>();
  /** Outgoing radio payloads (what the pod would have heard), one per attempt. */
  readonly transmitted: Bytes[] = [];

  constructor(o: RileyLinkSimulatorOptions = {}) {
    this.id = o.id ?? 'rileylink-sim-1';
    this.name = o.name ?? 'RileyLink';
    this.bleFirmware = o.bleFirmware ?? 'ble_rfspy 2.0';
    this.radioFirmware = o.radioFirmware ?? 'subg_rfspy 2.2';
    this.framing = responseFraming(parseBleFirmware(this.bleFirmware));
    const rf = parseRadioFirmware(this.radioFirmware);
    this.caps = radioCapabilities(rf ?? { components: [0], versionString: 'Unknown' });
    this.battery = o.batteryPercent ?? 87;
    this.rssi = o.rssi ?? -60;
    this.responder = o.onRadio ?? (() => null);
  }

  // ── test controls ─────────────────────────────────────────────────────────────

  setRadioResponder(r: RadioResponder): void {
    this.responder = r;
  }

  /** The command channel hangs: commands are accepted but never answered (-> `commandsBlocked`). */
  swallowCommands(on: boolean): void {
    this.swallow = on;
  }

  /** The next command is first answered with `commandInterrupted` (an idle GetPacket was preempted). */
  interruptNextCommand(): void {
    this.interruptNext = true;
  }

  setBattery(percent: number): void {
    this.battery = percent;
  }

  // ── FakePeripheral ────────────────────────────────────────────────────────────

  onConnect(link: PeripheralLink): void {
    this.link = link;
    this.responses = [];
  }

  onRead(service: string, characteristic: string): Bytes {
    if (service === RILEYLINK_BATTERY_SERVICE_UUID && characteristic === RL_BATTERY_LEVEL_CHAR) return u8(this.battery);
    if (characteristic === RL_CHAR.firmwareVersion) return stringToBytes(this.bleFirmware);
    if (characteristic === RL_CHAR.ledMode) return u8(this.diagnosticLed);
    if (characteristic === RL_CHAR.data) return this.responses.shift() ?? new Uint8Array(0);
    throw new Error(`unreadable characteristic ${characteristic}`);
  }

  async onWrite(_service: string, characteristic: string, data: Bytes): Promise<void> {
    if (characteristic === RL_CHAR.customName) {
      this.customName = asciiToString(data);
      return;
    }
    if (characteristic === RL_CHAR.ledMode) {
      this.diagnosticLed = data[0] ?? 0;
      return;
    }
    if (characteristic !== RL_CHAR.data) return;
    const length = data[0] ?? 0;
    const command = data.slice(1, 1 + length);
    this.commands.push({ code: command[0] ?? 0, payload: command.slice(1) });
    if (this.swallow) return;
    if (this.interruptNext) {
      this.interruptNext = false;
      this.publish(this.framing === 'single' ? u8(ResponseCode.commandInterrupted) : u8(ResponseCode.commandInterrupted, 0));
    }
    await this.handle(command);
  }

  // ── protocol ──────────────────────────────────────────────────────────────────

  /** Queues one response and tells the central via responseCount. */
  private publish(bytes: Bytes): void {
    this.responses.push(bytes);
    this.responseCount = (this.responseCount + 1) & 0xff;
    this.link?.notify(RILEYLINK_SERVICE_UUID, RL_CHAR.responseCount, u8(this.responseCount));
  }

  /** Code-only response (single: `[code]`, legacy: success is empty, errors are the code byte). */
  private reply(code: number, body: Bytes = new Uint8Array(0)): void {
    if (this.framing === 'single') this.publish(concatBytes(u8(code), body));
    else this.publish(concatBytes(code === ResponseCode.success ? new Uint8Array(0) : u8(code), body, u8(0)));
  }

  private async handle(c: Bytes): Promise<void> {
    const code = c[0];
    switch (code) {
      case CMD.getVersion:
        return this.publishVersion();
      case CMD.getPacket:
        return this.radio(null, 1, 'listen');
      case CMD.sendPacket:
        return this.handleSendPacket(c);
      case CMD.sendAndListen:
        return this.handleSendAndListen(c);
      case CMD.updateRegister:
        return this.handleUpdateRegister(c);
      case CMD.readRegister:
        return this.handleReadRegister(c);
      case CMD.setModeRegisters:
        return this.handleSetModeRegisters(c);
      case CMD.setSWEncoding:
        if (!this.caps.supportsSoftwareEncoding) return this.reply(ResponseCode.unknownCommand);
        this.softwareEncoding = c[1] ?? 0;
        return this.reply(ResponseCode.success);
      case CMD.setPreamble:
        if (!this.caps.supportsCustomPreamble) return this.reply(ResponseCode.unknownCommand);
        this.preamble = ((c[1] ?? 0) << 8) | (c[2] ?? 0);
        return this.reply(ResponseCode.success);
      case CMD.resetRadioConfig:
        if (!this.caps.supportsResetRadioConfig) return this.reply(ResponseCode.unknownCommand);
        this.registers.clear();
        this.modeRegisters.clear();
        this.softwareEncoding = 0;
        this.preamble = 0;
        return this.reply(ResponseCode.success);
      case CMD.setLEDMode:
        this.radioLeds.set(c[1] ?? 0, c[2] ?? 0);
        return this.reply(ResponseCode.success);
      case CMD.getStatistics:
        return this.handleStatistics();
      default:
        return this.reply(ResponseCode.unknownCommand);
    }
  }

  private publishVersion(): void {
    const v = stringToBytes(this.radioFirmware);
    if (this.framing === 'single') this.publish(concatBytes(u8(ResponseCode.success), v));
    else this.publish(concatBytes(v, u8(0)));
  }

  private handleUpdateRegister(c: Bytes): void {
    const [reg, value] = [c[1] ?? 0, c[2] ?? 0];
    const known = REGISTER_ADDRESSES.has(reg);
    if (known) this.registers.set(reg, value);
    if (this.framing === 'single') this.reply(known ? ResponseCode.success : ResponseCode.invalidParam);
    else this.publish(u8(known ? 1 : 2, 0));
  }

  private handleReadRegister(c: Bytes): void {
    if (!this.caps.supportsReadRegister) return this.reply(ResponseCode.unknownCommand);
    const reg = c[1] ?? 0;
    if (!REGISTER_ADDRESSES.has(reg)) return this.reply(ResponseCode.invalidParam, u8(0));
    const value = this.registers.get(reg) ?? 0;
    if (this.framing === 'single') this.publish(u8(ResponseCode.success, value));
    else this.publish(u8(value, 0));
  }

  private handleSetModeRegisters(c: Bytes): void {
    const pairs: number[] = [];
    for (let i = 2; i + 1 < c.length; i += 2) pairs.push(c[i]!, c[i + 1]!);
    this.modeRegisters.set(c[1] ?? 0, pairs);
    if (this.framing === 'single') this.reply(ResponseCode.success);
    else this.publish(u8(1, 0));
  }

  private handleStatistics(): void {
    const stats = new Uint8Array(16);
    new DataView(stats.buffer).setUint32(0, 123_456);
    new DataView(stats.buffer).setUint16(8, this.packetCounter);
    new DataView(stats.buffer).setUint16(10, this.transmitted.length);
    if (this.framing === 'single') this.publish(concatBytes(u8(ResponseCode.success), stats));
    else this.publish(concatBytes(stats, u8(0)));
  }

  private async handleSendPacket(c: Bytes): Promise<void> {
    // [cmd, channel, repeat, delay(2|1), preamble(2 if supported), data...]
    const offset = 3 + (this.caps.supports16BitPacketDelay ? 2 : 1) + (this.caps.supportsPreambleExtension ? 2 : 0);
    this.transmitted.push(c.slice(offset));
    this.reply(ResponseCode.success);
  }

  private async handleSendAndListen(c: Bytes): Promise<void> {
    // [cmd, sendCh, repeat, delay(2|1), listenCh, timeout(4), retry, preamble(2 if supported), data...]
    let o = 3 + (this.caps.supports16BitPacketDelay ? 2 : 1);
    o += 1 + 4;
    const retryCount = c[o] ?? 0;
    o += 1 + (this.caps.supportsPreambleExtension ? 2 : 0);
    await this.radio(c.slice(o), retryCount + 1, 'sendAndListen');
  }

  /** Runs up to `attempts` over-the-air attempts; the firmware reports rxTimeout when none is answered. */
  private async radio(tx: Bytes | null, attempts: number, _kind: string): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if (tx) this.transmitted.push(tx.slice());
      const heard = await this.responder(tx ? tx.slice() : null);
      if (heard) {
        this.packetCounter = (this.packetCounter + 1) & 0xff;
        const body = encodeRfPacket({ rssi: this.rssi, packetCounter: this.packetCounter, data: heard });
        if (this.framing === 'single') this.publish(concatBytes(u8(ResponseCode.success), body));
        else this.publish(concatBytes(body, u8(0)));
        return;
      }
    }
    this.publish(this.framing === 'single' ? u8(ResponseCode.rxTimeout) : u8(ResponseCode.rxTimeout, 0));
  }
}
