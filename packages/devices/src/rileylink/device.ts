/**
 * TypeScript port of `RileyLinkBluetoothDevice.swift`, `CommandSession.swift` and the version/battery
 * helpers of `PeripheralManager+RileyLink.swift` from RileyLinkBLEKit (RileyLinkKit, MIT License,
 * (c) Pete Schwamb).
 *
 * `RileyLinkDevice` drives a RileyLink / OrangeLink / EmaLink over the injected `BleTransport`.
 * Not ported: idle listening (GetPacket without a waiting reader), timerTick, OrangeLink vendor
 * commands and secure-DFU.
 */
import { silentLogger, type BleAdvertisement, type BleConnection, type BleTransport, type Bytes, type Logger } from '@buddy/core';
import { asciiToString, clampUnsigned, stringToBytes } from './bytes';
import { CommandChannel } from './channel';
import {
  getPacketCommand,
  getStatisticsCommand,
  getVersionCommand,
  readRegisterCommand,
  resetRadioConfigCommand,
  sendAndListenCommand,
  sendPacketCommand,
  setLedModeCommand,
  setModeRegistersCommand,
  setPreambleCommand,
  setSoftwareEncodingCommand,
  updateRegisterCommand,
  type RegisterSetting,
  type RlCommand,
} from './commands';
import {
  CC111XRegister,
  EXPECTED_MAX_BLE_LATENCY_MS,
  RILEYLINK_BATTERY_SERVICE_UUID,
  RILEYLINK_SERVICE_UUID,
  RL_BATTERY_LEVEL_CHAR,
  RL_CHAR,
  ResponseCode,
  RileyLinkLedMode,
  RileyLinkLedType,
  XTAL_FREQUENCY_HZ,
  type CC111XRegisterAddress,
  type RegisterModeValue,
  type RileyLinkLedModeValue,
  type SoftwareEncodingValue,
} from './constants';
import { errorMessage, RileyLinkError } from './errors';
import {
  isUnknownFirmware,
  parseBleFirmware,
  parseRadioFirmware,
  radioCapabilities,
  responseFraming,
  UNKNOWN_FIRMWARE,
  type FirmwareVersion,
  type RadioCapabilities,
} from './firmware';
import type { RFPacket } from './rf-packet';
import type { PacketResponse, RileyLinkStatistics, RlResponse } from './responses';

export interface RileyLinkAdvertisement {
  readonly id: string;
  readonly name: string | null;
  readonly rssi: number | null;
}

/** Scans for peripherals advertising the RileyLink service; de-duplicated by id, resolves after `timeoutMs`. */
export async function scanRileyLinks(
  ble: BleTransport,
  o: { readonly timeoutMs: number; readonly onFound?: (ad: RileyLinkAdvertisement) => void },
): Promise<readonly RileyLinkAdvertisement[]> {
  const found = new Map<string, RileyLinkAdvertisement>();
  await ble.scan({ services: [RILEYLINK_SERVICE_UUID], timeoutMs: o.timeoutMs }, (ad: BleAdvertisement) => {
    if (!ad.serviceUuids.map((s) => s.toLowerCase()).includes(RILEYLINK_SERVICE_UUID)) return;
    const entry = { id: ad.id, name: ad.name, rssi: ad.rssi };
    const isNew = !found.has(ad.id);
    found.set(ad.id, entry);
    if (isNew) o.onFound?.(entry);
  });
  return [...found.values()];
}

export interface RileyLinkOptions {
  readonly log?: Logger;
  /** Added to every command timeout (RileyLinkKit: 2 s). */
  readonly bleLatencyMs?: number;
  /** Timeout for reading the radio version during connect (RileyLinkKit: 1 s). */
  readonly versionTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export interface SendAndListenOptions {
  /** Extra times to repeat the packet before listening (0 = send once). */
  readonly repeatCount: number;
  /** How long to listen for a reply per attempt. */
  readonly timeoutMs: number;
  /** Times the radio repeats the send-and-listen cycle when nothing is heard. */
  readonly retryCount: number;
  /** Continuous preamble before the packet (firmware >= 2). */
  readonly preambleExtensionMs?: number;
}

/** RF packet exchange; what ErosMessageTransport needs from a radio. */
export interface PacketRadio {
  sendAndListen(data: Bytes, options: SendAndListenOptions): Promise<RFPacket>;
}

const RADIO_SWITCH_TIME_MS = 17; // at least 17 ms between packets for the radio to stop/start
const BITRATE = 16_384;

export class RileyLinkDevice implements PacketRadio {
  private constructor(
    readonly id: string,
    readonly bleFirmware: FirmwareVersion,
    readonly radioFirmware: FirmwareVersion,
    private readonly conn: BleConnection,
    private readonly channel: CommandChannel,
    private readonly log: Logger,
    private readonly bleLatencyMs: number,
  ) {}

  /**
   * Connects, subscribes to the response channel and reads both firmware versions.
   * Unknown / unparsable versions fall back to the oldest behaviour (buffered framing, no v2 features).
   */
  static async connect(ble: BleTransport, deviceId: string, o: RileyLinkOptions = {}): Promise<RileyLinkDevice> {
    const log = o.log ?? silentLogger;
    const bleLatencyMs = o.bleLatencyMs ?? EXPECTED_MAX_BLE_LATENCY_MS;
    const conn = await ble.connect(deviceId, o.connectTimeoutMs === undefined ? undefined : { timeoutMs: o.connectTimeoutMs });
    let channel: CommandChannel | null = null;
    try {
      channel = await CommandChannel.open(conn, log);
      const bleVersionString = asciiToString(await conn.read(RILEYLINK_SERVICE_UUID, RL_CHAR.firmwareVersion));
      const bleFw = parseBleFirmware(bleVersionString);
      if (!bleFw) log.warn(`RileyLink: unrecognised BLE firmware "${bleVersionString}"`);
      channel.framing = responseFraming(bleFw);

      const versionCmd = getVersionCommand();
      const resp = await channel.execute(versionCmd.data, versionCmd.parser, (o.versionTimeoutMs ?? 1000) + bleLatencyMs);
      if (resp.code !== ResponseCode.success) throw new RileyLinkError('invalidResponse', `RileyLink version request failed (code ${resp.code})`);
      const radio = parseRadioFirmware(resp.version);
      if (!radio) log.warn(`RileyLink: unrecognised radio firmware "${resp.version}"`);
      log.info(`RileyLink connected: ${bleVersionString} / ${resp.version}`);
      return new RileyLinkDevice(deviceId, bleFw ?? UNKNOWN_FIRMWARE, radio ?? UNKNOWN_FIRMWARE, conn, channel, log, bleLatencyMs);
    } catch (e) {
      channel?.close();
      await conn.disconnect().catch(() => undefined);
      throw e;
    }
  }

  get capabilities(): RadioCapabilities {
    return radioCapabilities(this.radioFirmware);
  }

  get isConnected(): boolean {
    return this.channel.isOpen;
  }

  /** Human readable "subg_rfspy 2.2 / ble_rfspy 2.0". */
  get firmwareDescription(): string {
    return [this.radioFirmware, this.bleFirmware].filter((v) => !isUnknownFirmware(v)).map((v) => v.versionString).join(' / ');
  }

  onDisconnect(listener: (error: Error | null) => void): () => void {
    return this.conn.onDisconnect(listener);
  }

  async disconnect(): Promise<void> {
    this.channel.close();
    await this.conn.disconnect();
  }

  // ── command plumbing ──────────────────────────────────────────────────────────

  /**
   * Runs a command and maps non-success response codes to errors like RileyLinkKit's `CommandSession`.
   * `timeoutMs` is the radio-side budget; BLE latency is added here.
   */
  private async run<R extends RlResponse>(command: RlCommand<R>, timeoutMs: number): Promise<R> {
    const response = await this.channel.execute(command.data, command.parser, timeoutMs + this.bleLatencyMs);
    switch (response.code) {
      case ResponseCode.success:
        return response;
      case ResponseCode.rxTimeout:
      case ResponseCode.commandInterrupted:
        throw new RileyLinkError('responseTimeout', 'Pump did not respond in time');
      case ResponseCode.zeroData:
        throw new RileyLinkError('invalidResponse', 'RileyLink returned no data');
      case ResponseCode.invalidParam:
        throw new RileyLinkError('errorResponse', `RileyLink reported invalid param (command ${command.code})`);
      case ResponseCode.unknownCommand:
        throw new RileyLinkError('errorResponse', `RileyLink reported unknown command (${command.code})`);
    }
  }

  private requireFeature(supported: boolean, name: string): void {
    if (!supported) throw new RileyLinkError('unsupportedCommand', `RileyLink firmware does not support the ${name} command`);
  }

  private async packetOf(command: RlCommand<PacketResponse>, timeoutMs: number): Promise<RFPacket> {
    const r = await this.run(command, timeoutMs);
    if (!r.packet) throw new RileyLinkError('invalidResponse', 'RileyLink response carried no packet');
    return r.packet;
  }

  // ── radio configuration ───────────────────────────────────────────────────────

  async updateRegister(address: CC111XRegisterAddress, value: number): Promise<void> {
    await this.run(updateRegisterCommand(address, value, this.capabilities), 0);
  }

  async readRegister(address: CC111XRegisterAddress): Promise<number> {
    this.requireFeature(this.capabilities.supportsReadRegister, 'readRegister');
    return (await this.run(readRegisterCommand(address, this.capabilities), 0)).value;
  }

  /** Sets FREQ2..0 for a carrier frequency (24 MHz crystal, 16-bit fractional). */
  async setBaseFrequency(megahertz: number): Promise<void> {
    const val = Math.trunc((megahertz * 1e6) / (XTAL_FREQUENCY_HZ / 65536));
    await this.updateRegister(CC111XRegister.freq0, val & 0xff);
    await this.updateRegister(CC111XRegister.freq1, (val >> 8) & 0xff);
    await this.updateRegister(CC111XRegister.freq2, (val >> 16) & 0xff);
  }

  async readBaseFrequency(): Promise<number> {
    const f0 = await this.readRegister(CC111XRegister.freq0);
    const f1 = await this.readRegister(CC111XRegister.freq1);
    const f2 = await this.readRegister(CC111XRegister.freq2);
    return ((f0 + (f1 << 8) + (f2 << 16)) * (XTAL_FREQUENCY_HZ / 65536)) / 1e6;
  }

  async setModeRegisters(mode: RegisterModeValue, settings: readonly RegisterSetting[]): Promise<void> {
    await this.run(setModeRegistersCommand(mode, settings), 0);
  }

  async setSoftwareEncoding(type: SoftwareEncodingValue): Promise<void> {
    this.requireFeature(this.capabilities.supportsSoftwareEncoding, 'setSWEncoding');
    await this.run(setSoftwareEncodingCommand(type), 0);
  }

  async setPreamble(value: number): Promise<void> {
    this.requireFeature(this.capabilities.supportsCustomPreamble, 'setPreamble');
    await this.run(setPreambleCommand(value), 0);
  }

  /** No-op on firmware without the command (matches RileyLinkKit). */
  async resetRadioConfig(): Promise<void> {
    if (!this.capabilities.supportsResetRadioConfig) return;
    await this.run(resetRadioConfigCommand(), 0);
  }

  /** `on` maps to the firmware's automatic LED mode; anything else turns the LEDs off (RileyLinkKit `setCCLEDMode`). */
  async setRadioLeds(on: boolean): Promise<void> {
    const mode = on ? RileyLinkLedMode.auto : RileyLinkLedMode.off;
    await this.run(setLedModeCommand(RileyLinkLedType.blue, mode), 0);
    await this.run(setLedModeCommand(RileyLinkLedType.green, mode), 0);
  }

  async getStatistics(): Promise<RileyLinkStatistics> {
    this.requireFeature(this.capabilities.supportsStatistics, 'getStatistics');
    return (await this.run(getStatisticsCommand(), 0)).statistics;
  }

  // ── radio traffic ─────────────────────────────────────────────────────────────

  /**
   * Sends `data` and listens for a reply.
   * @throws RileyLinkError `responseTimeout` when nothing was heard after all retries.
   */
  async sendAndListen(data: Bytes, o: SendAndListenOptions): Promise<RFPacket> {
    const preambleExtensionMs = o.preambleExtensionMs ?? 0;
    const command = sendAndListenCommand(
      {
        outgoing: data,
        sendChannel: 0,
        repeatCount: clampUnsigned(o.repeatCount, 8),
        delayBetweenPacketsMs: 0,
        listenChannel: 0,
        timeoutMs: clampUnsigned(o.timeoutMs, 32),
        retryCount: clampUnsigned(o.retryCount, 8),
        preambleExtensionMs: clampUnsigned(preambleExtensionMs, 16),
      },
      this.capabilities,
    );
    const singleSendMs = ((data.length * 8) / BITRATE) * 1000;
    const totalRepeatSendMs = (singleSendMs + RADIO_SWITCH_TIME_MS + preambleExtensionMs) * (o.repeatCount + 1);
    const totalTimeoutMs = (totalRepeatSendMs + o.timeoutMs) * (o.retryCount + 1);
    return this.packetOf(command, totalTimeoutMs);
  }

  /** Listens without sending; `responseTimeout` when nothing arrives. */
  async listen(timeoutMs: number): Promise<RFPacket> {
    return this.packetOf(getPacketCommand(0, clampUnsigned(timeoutMs, 32)), timeoutMs);
  }

  async send(data: Bytes, o: { readonly channel?: number; readonly timeoutMs?: number } = {}): Promise<void> {
    const command = sendPacketCommand(
      { outgoing: data, sendChannel: clampUnsigned(o.channel ?? 0, 8), repeatCount: 0, delayBetweenPacketsMs: 0, preambleExtensionMs: 0 },
      this.capabilities,
    );
    await this.run(command, o.timeoutMs ?? 0);
  }

  // ── BLE-side characteristics ──────────────────────────────────────────────────

  /** Battery percentage, or null when the device has no battery service. */
  async readBatteryLevel(): Promise<number | null> {
    try {
      const v = await this.conn.read(RILEYLINK_BATTERY_SERVICE_UUID, RL_BATTERY_LEVEL_CHAR);
      return v.length > 0 ? v[0]! : null;
    } catch (e) {
      this.log.warn(`RileyLink battery read failed: ${errorMessage(e)}`);
      return null;
    }
  }

  async readDiagnosticLedMode(): Promise<RileyLinkLedModeValue | null> {
    try {
      const v = await this.conn.read(RILEYLINK_SERVICE_UUID, RL_CHAR.ledMode);
      const m = v[0];
      return m === 0 || m === 1 || m === 2 ? m : null;
    } catch {
      return null;
    }
  }

  /** Controls the diagnostic LED (BLE side, independent of the radio LEDs). */
  async setDiagnosticLedMode(mode: RileyLinkLedModeValue): Promise<void> {
    await this.bleWrite(RL_CHAR.ledMode, new Uint8Array([mode]));
  }

  async setCustomName(name: string): Promise<void> {
    await this.bleWrite(RL_CHAR.customName, stringToBytes(name));
  }

  private async bleWrite(characteristic: string, value: Bytes): Promise<void> {
    try {
      await this.conn.write(RILEYLINK_SERVICE_UUID, characteristic, value, true);
    } catch (e) {
      throw new RileyLinkError('bleError', `RileyLink write failed: ${errorMessage(e)}`);
    }
  }
}
