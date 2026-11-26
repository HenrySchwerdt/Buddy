/**
 * TypeScript port of `Response.swift` and `ResponseBuffer.swift` from RileyLinkBLEKit
 * (RileyLinkKit, MIT License, (c) Pete Schwamb).
 *
 * Each response has a `parse` for BLE firmware >= 2 (one response per notification, first byte is the
 * response code) and a `parseLegacy` for older firmware (0x00-delimited buffer, no code byte).
 */
import { u32be, type Bytes } from '@buddy/core';
import { asciiToString } from './bytes';
import { isResponseCode, ResponseCode, type ResponseCodeValue } from './constants';
import { decodeRfPacket, type RFPacket } from './rf-packet';

export interface RlResponse {
  readonly code: ResponseCodeValue;
}

export interface ResponseParser<R extends RlResponse> {
  parse(data: Bytes): R | null;
  parseLegacy(data: Bytes): R | null;
}

const codeOf = (data: Bytes): ResponseCodeValue | null => (data.length > 0 && isResponseCode(data[0]!) ? data[0] : null);
const ok = (): { code: ResponseCodeValue } => ({ code: ResponseCode.success });

export const codeResponse: ResponseParser<RlResponse> = {
  parse: (d) => (d.length === 1 && isResponseCode(d[0]!) ? { code: d[0] } : null),
  parseLegacy: (d) => (d.length === 0 ? ok() : null),
};

export interface ReadRegisterResponse extends RlResponse {
  readonly value: number;
}
export const readRegisterResponse: ResponseParser<ReadRegisterResponse> = {
  parse: (d) => {
    const code = d.length > 1 ? codeOf(d) : null;
    return code === null ? null : { code, value: d[1]! };
  },
  parseLegacy: (d) => (d.length > 0 ? { code: ResponseCode.success, value: d[0]! } : null),
};

export const updateRegisterResponse: ResponseParser<RlResponse> = {
  parse: (d) => {
    const code = codeOf(d);
    return code === null ? null : { code };
  },
  parseLegacy: (d) => {
    if (d.length === 0) return null;
    if (d[0] === 1) return { code: ResponseCode.success };
    if (d[0] === 2) return { code: ResponseCode.invalidParam };
    return null;
  },
};

export interface VersionResponse extends RlResponse {
  readonly version: string;
}
export const versionResponse: ResponseParser<VersionResponse> = {
  parse: (d) => {
    const code = d.length > 1 ? codeOf(d) : null;
    return code === null ? null : { code, version: asciiToString(d.subarray(1)) };
  },
  parseLegacy: (d) => ({ code: ResponseCode.success, version: asciiToString(d) }),
};

export interface RileyLinkStatistics {
  readonly uptimeMs: number;
  readonly radioRxOverflowCount: number;
  readonly radioRxFifoOverflowCount: number;
  readonly packetRxCount: number;
  readonly packetTxCount: number;
  readonly crcFailureCount: number;
  readonly spiSyncFailureCount: number;
}
export interface StatisticsResponse extends RlResponse {
  readonly statistics: RileyLinkStatistics;
}
const statsFrom = (code: ResponseCodeValue, d: Bytes): StatisticsResponse | null => {
  if (d.length < 16) return null;
  const u16 = (o: number) => (d[o]! << 8) | d[o + 1]!;
  return {
    code,
    statistics: {
      uptimeMs: u32be(d, 0),
      radioRxOverflowCount: u16(4),
      radioRxFifoOverflowCount: u16(6),
      packetRxCount: u16(8),
      packetTxCount: u16(10),
      crcFailureCount: u16(12),
      spiSyncFailureCount: u16(14),
    },
  };
};
export const statisticsResponse: ResponseParser<StatisticsResponse> = {
  parse: (d) => {
    const code = d.length > 1 ? codeOf(d) : null;
    return code === null ? null : statsFrom(code, d.subarray(1));
  },
  parseLegacy: (d) => statsFrom(ResponseCode.success, d),
};

export interface PacketResponse extends RlResponse {
  readonly packet: RFPacket | null;
}
export const packetResponse: ResponseParser<PacketResponse> = {
  parse: (d) => {
    const code = codeOf(d);
    if (code === null) return null;
    if (code !== ResponseCode.success) return { code, packet: null };
    const packet = d.length > 1 ? decodeRfPacket(d.subarray(1)) : null;
    return packet === null ? null : { code, packet };
  },
  parseLegacy: (d) => {
    if (d.length === 0) return null;
    const packet = decodeRfPacket(d);
    if (packet !== null) return { code: ResponseCode.success, packet };
    const code = codeOf(d);
    return code === null ? null : { code, packet: null };
  },
};

/** Splits `data` on `endMarker` (keeping empty segments) like Swift `split(omittingEmptySubsequences: false)`. */
export function splitOn(data: Bytes, endMarker: number): Bytes[] {
  const out: Bytes[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === endMarker) {
      out.push(data.slice(start, i));
      start = i + 1;
    }
  }
  out.push(data.slice(start));
  return out;
}

/** All parsable responses in a legacy buffer; empty until at least one end marker was received. */
export function legacyResponses<R extends RlResponse>(parser: ResponseParser<R>, buffer: Bytes, endMarker = 0x00): R[] {
  const segments = splitOn(buffer, endMarker);
  if (segments.length <= 1) return [];
  const out: R[] = [];
  for (const s of segments) {
    const r = parser.parseLegacy(s);
    if (r !== null) out.push(r);
  }
  return out;
}
