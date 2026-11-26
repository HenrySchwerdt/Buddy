/**
 * TypeScript port of CRC16.swift and SyaiNotifyInfo.swift from SyaiKit (MIT, © 2026 Nightscout
 * Foundation). Decodes the routine `0x77XX` status frames of the `errorInfo` characteristic.
 * Diagnostics only: nothing decoded here may latch a sensor fault.
 */
import type { Bytes } from '@buddy/core';
import { hex } from '@buddy/core';
import { utf8Decode } from './bytes';

/** CRC16/Modbus: init 0xFFFF, poly 0xA001 (reflected), no final xor. */
export function crc16Modbus(bytes: Bytes): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

export interface NotifyEvent {
  readonly tick: number;
  readonly reason: number;
  readonly lastStatus: number | null;
}

export type NotifyContent =
  | { readonly kind: 'disconnectLog'; readonly events: readonly NotifyEvent[] }
  | { readonly kind: 'rebootLog'; readonly events: readonly NotifyEvent[] }
  | { readonly kind: 'intervalInfo'; readonly interval: number | null; readonly delay: number | null; readonly timeout: number | null }
  | { readonly kind: 'coefficients'; readonly values: readonly number[]; readonly crc: number | null; readonly crcOK: boolean }
  | { readonly kind: 'stateText'; readonly text: string }
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'rawHex'; readonly hex: string }
  | { readonly kind: 'malformed'; readonly header: number; readonly hex: string };

export interface NotifyFrame {
  readonly header: number;
  readonly content: NotifyContent;
  /** The whole frame verbatim. */
  readonly orgHex: string;
}

const le16 = (b: Bytes, i: number): number => b[i]! | (b[i + 1]! << 8);
const le32 = (b: Bytes, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const be32 = (b: Bytes, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

export function reasonName(reason: number): string {
  switch (reason) {
    case 0x1008: return 'orderly';
    case 0x1013: return 'abnormal/early';
    case 0x1016: return 'central-side';
    default: return `0x${reason.toString(16).padStart(4, '0')}`;
  }
}

function floatBE(b: Bytes, i: number): number {
  const v = new DataView(new ArrayBuffer(4));
  v.setUint32(0, be32(b, i));
  return v.getFloat32(0);
}

function records(body: Bytes, width: number, make: (o: number) => NotifyEvent): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (let o = 0; o < body.length; o += width) out.push(make(o));
  return out;
}

function decodeContent(header: number, body: Bytes): NotifyContent {
  const malformed: NotifyContent = { kind: 'malformed', header, hex: hex(body) };
  switch (header) {
    case 0x7704:
      if (body.length === 0 || body.length % 8 !== 0) return malformed;
      return { kind: 'disconnectLog', events: records(body, 8, (o) => ({ tick: le32(body, o), reason: le32(body, o + 4), lastStatus: null })) };
    case 0x7705:
      if (body.length === 0 || body.length % 12 !== 0) return malformed;
      return { kind: 'rebootLog', events: records(body, 12, (o) => ({ tick: le32(body, o), reason: le32(body, o + 4), lastStatus: le32(body, o + 8) })) };
    case 0x7707:
      if (body.length === 6) return { kind: 'intervalInfo', interval: le16(body, 0), delay: le16(body, 2), timeout: le16(body, 4) };
      if (body.length === 2) return { kind: 'intervalInfo', interval: le16(body, 0), delay: null, timeout: null };
      return malformed;
    case 0x7708: {
      // Float32 big-endian records plus, when echoed from a write frame, a trailing CRC16 that
      // covers the ORIGINAL frame (`09 | count | floats`), not the stripped echo.
      const hasCRC = body.length % 4 === 2;
      const floatBytes = hasCRC ? body.length - 2 : body.length;
      if (floatBytes <= 0 || floatBytes % 4 !== 0) return malformed;
      const values: number[] = [];
      for (let o = 0; o < floatBytes; o += 4) values.push(floatBE(body, o));
      if (!hasCRC) return { kind: 'coefficients', values, crc: null, crcOK: false };
      const observed = le16(body, floatBytes);
      const original = new Uint8Array([0x09, values.length, ...body.subarray(0, floatBytes)]);
      return { kind: 'coefficients', values, crc: observed, crcOK: crc16Modbus(original) === observed };
    }
    case 0x7709:
      return { kind: 'stateText', text: utf8Decode(body) };
    case 0x770a:
      return { kind: 'rawHex', hex: hex(body) };
    default: {
      // 0x7706 and unknown headers: one little-endian integer.
      if (body.length === 0 || body.length > 6) return malformed;
      let v = 0;
      body.forEach((b, i) => {
        v += b * 2 ** (8 * i);
      });
      return { kind: 'value', value: v };
    }
  }
}

export function decodeNotifyInfo(data: Bytes): NotifyFrame | null {
  if (data.length < 2) return null;
  const header = le16(data, 0);
  return { header, content: decodeContent(header, data.subarray(2)), orgHex: hex(data) };
}

export function describeNotifyInfo(f: NotifyFrame): string {
  const c = f.content;
  const head = `0x${f.header.toString(16).padStart(4, '0')}`;
  switch (c.kind) {
    case 'disconnectLog':
      return `errorInfo ${head} disconnect_info ${c.events.length} event(s): ${c.events.map((e) => `tick=${e.tick} reason=${reasonName(e.reason)}`).join(', ')}`;
    case 'rebootLog':
      return `errorInfo ${head} reboot_info ${c.events.length} event(s): ${c.events.map((e) => `tick=${e.tick} reason=${reasonName(e.reason)} lastStatus=${e.lastStatus ?? '-'}`).join(', ')}`;
    case 'intervalInfo':
      return `errorInfo ${head} interval_info interval=${c.interval ?? '-'} delay=${c.delay ?? '-'} timeout=${c.timeout ?? '-'}`;
    case 'coefficients':
      return `errorInfo ${head} coefficient_info ${c.values.length} value(s)${c.crc === null ? '' : c.crcOK ? ' crc ok' : ' crc MISMATCH'}`;
    case 'stateText':
      return `errorInfo ${head} state_info "${c.text}"`;
    case 'value':
      return `errorInfo ${head} value ${c.value}`;
    case 'rawHex':
      return `errorInfo ${head} raw ${c.hex}`;
    case 'malformed':
      return `errorInfo ${head} MALFORMED body ${c.hex}`;
  }
}
