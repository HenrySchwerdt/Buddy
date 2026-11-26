/**
 * TypeScript port of SyaiFrameCipher.swift and SyaiFrameParser.swift from SyaiKit (MIT,
 * © 2026 Nightscout Foundation): AES-ECB notify frames, record splitting and the raw channel
 * windows of the verified firmware versions V1.6 and V1.7.
 *
 * Only V1.6 and V1.7 have hardware-verified byte windows. Every other version throws, so a
 * plausible-but-wrong glucose never reaches the loop.
 */
import type { Bytes } from '@buddy/core';
import { ecb } from '@noble/ciphers/aes.js';

export const HEADER_WIDTH = 8;

export class FrameError extends Error {
  constructor(
    readonly reason: 'empty' | 'notBlockAligned' | 'shortOrg' | 'shortRecord' | 'notVerified',
    message: string,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

export interface PacketInfo {
  readonly crc: number;
  readonly errorCode: number;
  readonly startIndex: number;
  /** -1: non-paged (live push / connect burst). N >= 1: N more packets follow. 0: final packet. */
  readonly surplusPackage: number;
  readonly isBatchComplete: boolean;
}

export interface SplitRecord {
  readonly index: number;
  /** `[00 00] | index(2 LE) | record(recLen)`. */
  readonly framed: Bytes;
}

export interface RawChannels {
  readonly v0: number;
  readonly v1: number;
  readonly v2: number;
}

const le16 = (b: Bytes, o: number): number => b[o]! | (b[o + 1]! << 8);

/** V1.7, V1.8 and V2.0 firmware all parse as V1.7 per the vendor profile. */
export function parseVersionForDevice(version: string): string {
  if (version.includes('V1.7') || version.includes('V1.8.') || version.includes('V2.0.')) return 'V1.7';
  if (version.includes('V1.6')) return 'V1.6';
  return 'V1.5';
}

export const isVerifiedParseVersion = (parseVersion: string): boolean => parseVersion === 'V1.7' || parseVersion === 'V1.6';

/** Record width: 9 bytes for V1.7, else 8. */
export const recordLength = (parseVersion: string): number => (parseVersion === 'V1.7' ? 9 : 8);

export function decryptOrg(notify: Bytes, sessionKey: Bytes): Bytes {
  if (notify.length === 0) throw new FrameError('empty', 'frame: empty notify value');
  const aligned = notify.length - (notify.length % 16);
  if (aligned < 16) throw new FrameError('notBlockAligned', `frame: ${notify.length} bytes has no whole AES block`);
  return ecb(sessionKey, { disablePadding: true }).decrypt(notify.slice(0, aligned));
}

export function packetInfo(org: Bytes): PacketInfo {
  if (org.length < HEADER_WIDTH) throw new FrameError('shortOrg', `frame: org value ${org.length} bytes < ${HEADER_WIDTH}-byte header`);
  const raw = le16(org, 6);
  const surplusPackage = raw >= 0x8000 ? raw - 0x10000 : raw;
  return { crc: le16(org, 0), errorCode: le16(org, 2), startIndex: le16(org, 4), surplusPackage, isBatchComplete: surplusPackage <= 0 };
}

export function splitRecords(org: Bytes, recLen: number): SplitRecord[] {
  if (org.length < HEADER_WIDTH) throw new FrameError('shortOrg', `frame: org value ${org.length} bytes < ${HEADER_WIDTH}-byte header`);
  const base = le16(org, 4);
  const out: SplitRecord[] = [];
  let n = 0;
  for (let i = HEADER_WIDTH; i + recLen <= org.length; i += recLen, n++) {
    const data = org.subarray(i, i + recLen);
    if (data.every((x) => x === 0)) continue; // zero padding slot
    const index = (base + n) & 0xffff;
    const framed = new Uint8Array(4 + recLen);
    framed[2] = index & 0xff;
    framed[3] = index >> 8;
    framed.set(data, 4);
    out.push({ index, framed });
  }
  return out;
}

/**
 * V1.7 record `d(9)`: current = LE24(d[0:3]) & 0x3FFFF, runSec = LE24(d[4:7]) >> 2,
 * temperature = LE16(d[7:9]) / 100. `d[3]` is carried but not interpreted.
 */
function channelsV17(d: Bytes): RawChannels {
  const current = (d[0]! | (d[1]! << 8) | (d[2]! << 16)) & 0x3ffff;
  const runSec = (d[4]! | (d[5]! << 8) | (d[6]! << 16)) >>> 2;
  return { v0: current, v1: le16(d, 7) / 100, v2: runSec };
}

/**
 * V1.6 record `d(8)`: current = LE16(d[0:2]); LE32(d[4:8]) packs runSec (low 22 bits) and
 * temperature (10 bits above) / 10. runSec is read from the frame, never derived from the index
 * (a 16-bit read wraps every ~18.2 h).
 */
function channelsV16(d: Bytes): RawChannels {
  const timeAndTemp = (d[4]! | (d[5]! << 8) | (d[6]! << 16) | (d[7]! << 24)) >>> 0;
  return { v0: le16(d, 0), v1: (timeAndTemp >>> 22) / 10, v2: timeAndTemp & 0x3fffff };
}

/** `framed` is `[00 00] | index(2 LE) | record`. */
export function rawChannels(framed: Bytes, parseVersion: string): RawChannels {
  const need = parseVersion === 'V1.7' ? 9 : parseVersion === 'V1.6' ? 8 : null;
  if (need === null) throw new FrameError('notVerified', `glucose decode is gated: parse version ${parseVersion} is not hardware-verified`);
  const d = framed.subarray(4);
  if (d.length < need) throw new FrameError('shortRecord', `frame record too short (${framed.length} bytes) for the parsed fields`);
  return parseVersion === 'V1.7' ? channelsV17(d) : channelsV16(d);
}

export interface DecryptedFrame {
  /** `[00 00] | index(2 LE) | record`. */
  readonly plaintext: Bytes;
  readonly sequence: number;
  readonly parseVersion: string;
  readonly receivedAt: number;
  readonly isHistorical: boolean;
}
