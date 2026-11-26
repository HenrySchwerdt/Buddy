/**
 * Port of `Bluetooth/StringLengthPrefixEncoding.swift` from OmnipodKit (MIT License,
 * (c) LoopKit Authors): "KEY=" + 2 byte big-endian length + payload, as used by the pairing
 * messages and the encrypted command wrapper.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { be16, u16be } from '../common/bytes';
import { OmnipodError } from './errors';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LENGTH_BYTES = 2;

const bad = (m: string): OmnipodError => new OmnipodError('protocol', m);

export function parseKeys(keys: readonly string[], payload: Bytes): Bytes[] {
  const ret: Bytes[] = keys.map(() => new Uint8Array(0));
  let remaining = payload;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    const keyBytes = encoder.encode(key);
    if (remaining.length < keyBytes.length) throw bad('Payload too short');
    if (decoder.decode(remaining.subarray(0, keyBytes.length)) !== key) throw bad(`Key not found: ${key}`);
    if (index === keys.length - 1 && remaining.length === keyBytes.length) return ret;
    if (remaining.length < keyBytes.length + LENGTH_BYTES) throw bad('Payload too short');
    remaining = remaining.subarray(keyBytes.length);
    const length = u16be(remaining, 0);
    if (remaining.length < LENGTH_BYTES + length) throw bad('Payload too short');
    ret[index] = remaining.slice(LENGTH_BYTES, LENGTH_BYTES + length);
    remaining = remaining.subarray(LENGTH_BYTES + length);
  }
  return ret;
}

export function formatKeys(keys: readonly string[], payloads: readonly Bytes[]): Bytes {
  const parts: Bytes[] = [];
  keys.forEach((key, i) => {
    const payload = payloads[i]!;
    parts.push(encoder.encode(key));
    if (payload.length !== 0) parts.push(be16(payload.length), payload);
  });
  return concatBytes(...parts);
}
