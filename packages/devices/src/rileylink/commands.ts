/**
 * TypeScript port of `Command.swift` from RileyLinkBLEKit (RileyLinkKit, MIT License,
 * (c) Pete Schwamb): the byte layout of every subg_rfspy command. Layouts depend on the radio firmware.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { writeU16be, writeU32be } from './bytes';
import {
  CMD,
  RegisterModeType,
  RileyLinkLedMode,
  RileyLinkLedType,
  type CC111XRegisterAddress,
  type CommandCode,
  type RegisterModeValue,
  type RileyLinkLedModeValue,
  type SoftwareEncodingValue,
} from './constants';
import type { RadioCapabilities } from './firmware';
import {
  codeResponse,
  packetResponse,
  readRegisterResponse,
  statisticsResponse,
  updateRegisterResponse,
  versionResponse,
  type PacketResponse,
  type ReadRegisterResponse,
  type ResponseParser,
  type RlResponse,
  type StatisticsResponse,
  type VersionResponse,
} from './responses';

/** A command payload (without the length prefix) plus the parser for its response. */
export interface RlCommand<R extends RlResponse> {
  readonly code: CommandCode;
  readonly data: Bytes;
  readonly parser: ResponseParser<R>;
}

const cmd = <R extends RlResponse>(code: CommandCode, parser: ResponseParser<R>, ...parts: Bytes[]): RlCommand<R> => ({
  code,
  parser,
  data: concatBytes(new Uint8Array([code]), ...parts),
});
const u8 = (...b: number[]): Bytes => new Uint8Array(b);

export const getVersionCommand = (): RlCommand<VersionResponse> => cmd(CMD.getVersion, versionResponse);

export const getPacketCommand = (listenChannel: number, timeoutMs: number): RlCommand<PacketResponse> =>
  cmd(CMD.getPacket, packetResponse, u8(listenChannel), writeU32be(timeoutMs));

export interface SendAndListenParams {
  readonly outgoing: Bytes;
  /** In general 0 = meter/cgm, 2 = pump. */
  readonly sendChannel: number;
  /** 0 = no repeat (one packet), 1 = two packets sent in total. */
  readonly repeatCount: number;
  readonly delayBetweenPacketsMs: number;
  readonly listenChannel: number;
  readonly timeoutMs: number;
  readonly retryCount: number;
  readonly preambleExtensionMs: number;
}

export function sendAndListenCommand(p: SendAndListenParams, caps: RadioCapabilities): RlCommand<PacketResponse> {
  return cmd(
    CMD.sendAndListen,
    packetResponse,
    u8(p.sendChannel, p.repeatCount),
    caps.supports16BitPacketDelay ? writeU16be(p.delayBetweenPacketsMs) : u8(Math.min(p.delayBetweenPacketsMs, 255)),
    u8(p.listenChannel),
    writeU32be(p.timeoutMs),
    u8(p.retryCount),
    caps.supportsPreambleExtension ? writeU16be(p.preambleExtensionMs) : new Uint8Array(0),
    p.outgoing,
  );
}

export interface SendPacketParams {
  readonly outgoing: Bytes;
  readonly sendChannel: number;
  readonly repeatCount: number;
  readonly delayBetweenPacketsMs: number;
  readonly preambleExtensionMs: number;
}

export function sendPacketCommand(p: SendPacketParams, caps: RadioCapabilities): RlCommand<RlResponse> {
  return cmd(
    CMD.sendPacket,
    codeResponse,
    u8(p.sendChannel, p.repeatCount),
    caps.supports16BitPacketDelay ? writeU16be(p.delayBetweenPacketsMs) : u8(Math.min(p.delayBetweenPacketsMs, 255)),
    caps.supportsPreambleExtension ? writeU16be(p.preambleExtensionMs) : new Uint8Array(0),
    p.outgoing,
  );
}

export const updateRegisterCommand = (reg: CC111XRegisterAddress, value: number, caps: RadioCapabilities): RlCommand<RlResponse> =>
  cmd(CMD.updateRegister, updateRegisterResponse, u8(reg, value), caps.needsExtraByteForUpdateRegister ? u8(0) : new Uint8Array(0));

export const readRegisterCommand = (reg: CC111XRegisterAddress, caps: RadioCapabilities): RlCommand<ReadRegisterResponse> =>
  cmd(CMD.readRegister, readRegisterResponse, u8(reg), caps.needsExtraByteForReadRegister ? u8(reg) : new Uint8Array(0));

export interface RegisterSetting {
  readonly address: CC111XRegisterAddress;
  readonly value: number;
}

/** Programs a set of registers that the firmware applies automatically whenever it switches to TX or RX. */
export const setModeRegistersCommand = (mode: RegisterModeValue, settings: readonly RegisterSetting[]): RlCommand<RlResponse> =>
  cmd(CMD.setModeRegisters, updateRegisterResponse, u8(mode), ...settings.map((s) => u8(s.address, s.value)));

export const setSoftwareEncodingCommand = (type: SoftwareEncodingValue): RlCommand<RlResponse> => cmd(CMD.setSWEncoding, codeResponse, u8(type));
export const setPreambleCommand = (value: number): RlCommand<RlResponse> => cmd(CMD.setPreamble, codeResponse, writeU16be(value));
export const setLedModeCommand = (led: (typeof RileyLinkLedType)[keyof typeof RileyLinkLedType], mode: RileyLinkLedModeValue): RlCommand<RlResponse> =>
  cmd(CMD.setLEDMode, codeResponse, u8(led, mode));
export const resetRadioConfigCommand = (): RlCommand<RlResponse> => cmd(CMD.resetRadioConfig, codeResponse);
export const getStatisticsCommand = (): RlCommand<StatisticsResponse> => cmd(CMD.getStatistics, statisticsResponse);

export { RegisterModeType, RileyLinkLedMode, RileyLinkLedType };
