/**
 * Libre 3 NFC layer: patch info (`0xA1`), activation (`0xA0`) and switch-receiver (`0xA8`)
 * commands, their responses, the Abbott CRC-16 and receiver-id helpers.
 *
 * TypeScript port of RoundWhiteDiscKit `Pairing/NFCActivationCommand.swift`,
 * `NFCActivationModels.swift` and `Libre3ReceiverID.swift` (MIT, (c) the RoundWhiteDiscKit
 * authors). The CoreNFC / Android layer is `ctx.nfc` (`NfcIso15693Tag.customCommand`), which
 * supplies the manufacturer code `0x7A` itself.
 */
import { concatBytes, hex, u16le, writeU16le, writeU32le, type Bytes } from '@buddy/core';

export const NFC_READ_PATCH_INFO = 0xa1;
export const NFC_ACTIVATE = 0xa0;
export const NFC_SWITCH_RECEIVER = 0xa8;
export type Libre3NfcCommand = typeof NFC_ACTIVATE | typeof NFC_SWITCH_RECEIVER;

/** Patch-info state byte of a sensor that has not been activated yet. */
export const SENSOR_STATE_FACTORY = 0x01;

/** CRC-CCITT, init 0xFFFF, poly 0x1021, input bytes bit-reversed before entering the CRC. */
export function abbottCrc16(data: Bytes): number {
  let crc = 0xffff;
  for (const byte of data) {
    let reversed = 0;
    for (let i = 0; i < 8; i++) reversed |= ((byte >> i) & 1) << (7 - i);
    crc ^= reversed << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** `timeSeconds_LE4 || receiverID_LE4 || crc16_LE2` (command parameters, without code and manufacturer byte). */
export function activationParameters(timeSeconds: number, receiverId: number): Bytes {
  const body = concatBytes(writeU32le(timeSeconds >>> 0), writeU32le(receiverId >>> 0));
  return concatBytes(body, writeU16le(abbottCrc16(body)));
}

export class Libre3NfcError extends Error {
  constructor(readonly code: 'invalidPatchInfo' | 'invalidActivationResponse' | 'unexpectedSensorState', readonly raw?: Bytes) {
    super(`Libre 3 NFC: ${code}${raw ? ` (${raw.length} bytes)` : ''}`);
    this.name = 'Libre3NfcError';
  }
}

export interface Libre3PatchInfo {
  readonly stateByte: number;
  readonly productType: number;
  readonly securityVersion: number;
  /** 1 Europe, 2 US, 4 Australia/Canada, 8 eastern rest-of-world. */
  readonly region: number;
  /** 0 Libre 3, 1 Libre 3 Plus / Instinct. */
  readonly generation: number;
  readonly wearDurationMinutes: number;
  readonly warmupMinutes: number;
  readonly firmwareVersion: string;
  readonly serialNumber: string;
  readonly recommendedCommand: Libre3NfcCommand;
}

/** CoreNFC drops the leading status byte and may repeat `A5` padding; normalize to `00 A5 <body>`. */
function normalizePatchInfo(raw: Bytes): Bytes {
  const frame = raw[0] === 0xa5 ? concatBytes(Uint8Array.of(0), raw) : raw;
  if (frame.length < 2 || frame[0] !== 0x00 || frame[1] !== 0xa5) return raw;
  let bodyStart = 2;
  while (bodyStart < frame.length && frame[bodyStart] === 0xa5) bodyStart++;
  return bodyStart > 2 ? concatBytes(Uint8Array.of(0x00, 0xa5), frame.subarray(bodyStart)) : frame;
}

export function parsePatchInfo(raw: Bytes): Libre3PatchInfo {
  const f = normalizePatchInfo(raw);
  if (f.length < 29 || f[0] !== 0x00 || f[1] !== 0xa5) throw new Libre3NfcError('invalidPatchInfo', raw);
  const stateByte = f[17]!;
  return {
    stateByte,
    productType: f[15]!,
    securityVersion: u16le(f, 3),
    region: u16le(f, 5),
    generation: u16le(f, 7),
    wearDurationMinutes: u16le(f, 9),
    warmupMinutes: f[16]! * 5,
    firmwareVersion: `${f[14]}.${f[13]}.${f[12]}.${f[11]}`,
    serialNumber: String.fromCharCode(...f.subarray(18, 27)),
    recommendedCommand: stateByte === SENSOR_STATE_FACTORY ? NFC_ACTIVATE : NFC_SWITCH_RECEIVER,
  };
}

export interface Libre3ActivationResponse {
  /** BLE address in display order, `CC:22:DF:B8:F9:58`. */
  readonly bleAddress: string;
  /** 4-byte PIN used as the Phase 5 tail. Every switch-receiver issues a new one. */
  readonly blePin: Bytes;
  readonly activationTimeRaw: Bytes;
}

export function parseActivationResponse(raw: Bytes): Libre3ActivationResponse {
  const f = raw[0] === 0xa5 ? concatBytes(Uint8Array.of(0), raw) : raw;
  if (f.length !== 19 || f[0] !== 0x00 || f[1] !== 0xa5 || f[2] !== 0x00) throw new Libre3NfcError('invalidActivationResponse', raw);
  const address = Array.from(f.subarray(3, 9)).reverse().map((b) => b.toString(16).padStart(2, '0').toUpperCase());
  return { bleAddress: address.join(':'), blePin: f.slice(9, 13), activationTimeRaw: f.slice(13, 17) };
}

/** The sensor advertises its BLE address, uppercase hex without separators, as its local name. */
export const advertisedNameForAddress = (bleAddress: string): string => bleAddress.replace(/:/g, '').toUpperCase();

// ── receiver id ───────────────────────────────────────────────────────────────

export type ReceiverIdDerivation = 'freeStyleLibre3' | 'libreByAbbott';

/** 32-bit fold `h = (h * 0x811c9dc5) ^ unit` over UTF-16 code units (classic FreeStyle Libre 3 app). */
export function accountlessReceiverId(uniqueId: string): number {
  let value = 0;
  for (let i = 0; i < uniqueId.length; i++) value = (Math.imul(value, 0x811c9dc5) ^ uniqueId.charCodeAt(i)) >>> 0;
  return value;
}

/** Sum of consecutive 4-byte big-endian words of the UTF-8 account id (US "Libre by Abbott" app). */
function wordSumReceiverId(accountId: string): number {
  let sum = 0;
  let word = 0;
  let filled = 0;
  for (const byte of new TextEncoder().encode(accountId)) {
    word = ((word << 8) | byte) >>> 0;
    if (++filled === 4) {
      sum = (sum + word) >>> 0;
      word = 0;
      filled = 0;
    }
  }
  return filled > 0 ? (sum + word) >>> 0 : sum;
}

/** Receiver id an Abbott app derives from a LibreView account id; the caller must know which app activated the sensor. */
export function receiverIdFromAccount(accountId: string, derivation: ReceiverIdDerivation): number {
  const normalized = accountId.toLowerCase();
  return derivation === 'freeStyleLibre3' ? accountlessReceiverId(normalized) : wordSumReceiverId(normalized);
}

export const receiverIdToHex = (receiverId: number): string => hex(writeU32le(receiverId >>> 0));

export function parseReceiverIdHex(text: string): number | null {
  const clean = text.replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
  if (clean.length !== 8) return null;
  return (parseInt(clean.slice(0, 2), 16) | (parseInt(clean.slice(2, 4), 16) << 8) | (parseInt(clean.slice(4, 6), 16) << 16) | (parseInt(clean.slice(6, 8), 16) << 24)) >>> 0;
}
