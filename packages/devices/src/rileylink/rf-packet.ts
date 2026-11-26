/**
 * TypeScript port of `RFPacket.swift` from RileyLinkBLEKit (RileyLinkKit, MIT License,
 * (c) Pete Schwamb).
 */
import type { Bytes } from '@buddy/core';

export interface RFPacket {
  /** Payload as received over the air (after the radio's software decoding). */
  readonly data: Bytes;
  readonly packetCounter: number;
  /** dBm, as computed by RileyLinkKit (CC1110 RSSI byte, offset 73). */
  readonly rssi: number;
}

const RSSI_OFFSET = 73;

/** Decodes the rfspy response body: `[rssi, packetCounter, ...data]`. Null when shorter than 2 bytes. */
export function decodeRfPacket(rfspyResponse: Bytes): RFPacket | null {
  if (rfspyResponse.length < 2) return null;
  const rssiDec = rfspyResponse[0]!;
  // Swift integer division truncates toward zero.
  const rssi = (rssiDec >= 128 ? Math.trunc((rssiDec - 256) / 2) : Math.trunc(rssiDec / 2)) - RSSI_OFFSET;
  return { rssi, packetCounter: rfspyResponse[1]!, data: rfspyResponse.slice(2) };
}

/** Inverse of {@link decodeRfPacket}; used by simulators. `rssi` is quantised to half-dB steps. */
export function encodeRfPacket(p: { readonly rssi: number; readonly packetCounter: number; readonly data: Bytes }): Bytes {
  const raw = Math.round((p.rssi + RSSI_OFFSET) * 2);
  const rssiByte = raw < 0 ? raw + 256 : raw;
  const out = new Uint8Array(2 + p.data.length);
  out[0] = rssiByte & 0xff;
  out[1] = p.packetCounter & 0xff;
  out.set(p.data, 2);
  return out;
}
