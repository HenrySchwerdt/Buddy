/**
 * Port of `Bluetooth/Session/EapMessage.swift` and `EapAkaAttribute.swift` from OmnipodKit
 * (MIT License, (c) LoopKit Authors): the EAP-AKA messages exchanged to establish a session.
 *
 * DEVIATION: AT_AUTS is written in the RFC 4187 form (type, length, 14 byte AUTS), which only the
 * pod simulator produces; the controller never sends it.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { be16 } from '../common/bytes';
import { OmnipodError } from './errors';

export const EapCode = { REQUEST: 1, RESPONSE: 2, SUCCESS: 3, FAILURE: 4 } as const;
export type EapCode = (typeof EapCode)[keyof typeof EapCode];

export const EapAttr = { RAND: 0x01, AUTN: 0x02, RES: 0x03, AUTS: 0x04, CLIENT_ERROR_CODE: 0x22, CUSTOM_IV: 126 } as const;
export const SUBTYPE_AKA_CHALLENGE = 0x01;
export const SUBTYPE_SYNCHRONIZATION_FAILURE = 0x04;
const AKA_PACKET_TYPE = 0x17;
const HEADER_SIZE = 8;
const RES_PAYLOAD_SIZE_BITS = 0x64;

export interface EapAttribute {
  readonly type: number;
  readonly payload: Bytes;
}

export interface EapMessage {
  readonly code: EapCode;
  readonly identifier: number;
  readonly subType: number;
  readonly attributes: readonly EapAttribute[];
}

const bad = (m: string): OmnipodError => new OmnipodError('session', m);
const expectLength = (a: EapAttribute, n: number): EapAttribute => {
  if (a.payload.length !== n) throw bad(`EAP attribute 0x${a.type.toString(16)} has ${a.payload.length} bytes, expected ${n}`);
  return a;
};

export const rand = (payload: Bytes): EapAttribute => expectLength({ type: EapAttr.RAND, payload }, 16);
export const autn = (payload: Bytes): EapAttribute => expectLength({ type: EapAttr.AUTN, payload }, 16);
export const res = (payload: Bytes): EapAttribute => expectLength({ type: EapAttr.RES, payload }, 8);
export const auts = (payload: Bytes): EapAttribute => expectLength({ type: EapAttr.AUTS, payload }, 14);
export const customIv = (payload: Bytes): EapAttribute => expectLength({ type: EapAttr.CUSTOM_IV, payload }, 4);

function encodeAttribute(a: EapAttribute): Bytes {
  switch (a.type) {
    case EapAttr.RAND:
    case EapAttr.AUTN:
      return concatBytes(new Uint8Array([a.type, 5, 0, 0]), a.payload);
    case EapAttr.AUTS:
      return concatBytes(new Uint8Array([a.type, 4]), a.payload);
    case EapAttr.RES:
      return concatBytes(new Uint8Array([a.type, 3, 0, RES_PAYLOAD_SIZE_BITS]), a.payload);
    case EapAttr.CUSTOM_IV:
      return concatBytes(new Uint8Array([a.type, 2, 0, 0]), a.payload);
    case EapAttr.CLIENT_ERROR_CODE:
      return concatBytes(new Uint8Array([a.type, 1]), a.payload);
    default:
      throw bad(`Unknown EAP attribute 0x${a.type.toString(16)}`);
  }
}

export function encodeEap(m: EapMessage): Bytes {
  const attrs = concatBytes(...m.attributes.map(encodeAttribute));
  if (attrs.length === 0) return new Uint8Array([m.code, m.identifier, 0, 4]);
  const total = HEADER_SIZE + attrs.length;
  return concatBytes(new Uint8Array([m.code, m.identifier]), be16(total), new Uint8Array([AKA_PACKET_TYPE, m.subType || SUBTYPE_AKA_CHALLENGE, 0, 0]), attrs);
}

function parseAttributes(payload: Bytes): EapAttribute[] {
  const out: EapAttribute[] = [];
  let tail = payload;
  while (tail.length > 0) {
    if (tail.length < 2) throw bad('Not enough data');
    const size = 4 * tail[1]!;
    if (size === 0 || tail.length < size) throw bad('Not enough data');
    const type = tail[0]!;
    switch (type) {
      case EapAttr.RAND:
      case EapAttr.AUTN:
        out.push(expectLength({ type, payload: tail.slice(4, 20) }, 16));
        break;
      case EapAttr.RES:
        out.push(expectLength({ type, payload: tail.slice(4, 12) }, 8));
        break;
      case EapAttr.AUTS:
        out.push(expectLength({ type, payload: tail.slice(2, 16) }, 14));
        break;
      case EapAttr.CUSTOM_IV:
        out.push(expectLength({ type, payload: tail.slice(4, 8) }, 4));
        break;
      case EapAttr.CLIENT_ERROR_CODE:
        out.push({ type, payload: tail.slice(2, 4) });
        break;
      default:
        throw bad(`Unknown EAP attribute 0x${type.toString(16)}`);
    }
    tail = tail.subarray(size);
  }
  return out;
}

export function parseEap(payload: Bytes): EapMessage {
  if (payload.length < 4) throw bad('Not enough data');
  const total = (payload[2]! << 8) | payload[3]!;
  if (payload.length !== total) throw bad('Invalid EAP length');
  const code = payload[0]! as EapCode;
  if (code < 1 || code > 4) throw bad('Invalid EAP code');
  if (total === 4) return { code, identifier: payload[1]!, subType: 0, attributes: [] };
  if (payload[4] !== AKA_PACKET_TYPE) throw bad('Invalid EAP payload');
  return { code, identifier: payload[1]!, subType: payload[5]!, attributes: parseAttributes(payload.subarray(HEADER_SIZE)) };
}

export const findAttribute = (m: EapMessage, type: number): EapAttribute | undefined => m.attributes.find((a) => a.type === type);
