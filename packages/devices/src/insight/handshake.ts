/**
 * Plaintext handshake messages of section 4 (port of InsightKit `HandshakeMessage`).
 * They are JSON objects wrapped in a 0x01 envelope; nothing here is secret on its own, but
 * keys and MACs derived from them are never logged by the callers.
 */
import type { Bytes } from '@buddy/core';
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from './bytes';
import { INSIGHT_PROTOCOL_VERSION } from './constants';
import { handshakeBody, handshakeEnvelope } from './crypto';
import { BridgeError, isObject, type JsonObject } from './models';

export type HandshakeMessage = JsonObject;

export const pairStartMessage = (commit: Bytes): HandshakeMessage => ({ t: 'pairStart', v: INSIGHT_PROTOCOL_VERSION, commit: base64Encode(commit) });
export const pairRevealMessage = (publicKey: Bytes, nonce: Bytes): HandshakeMessage => ({ t: 'pairReveal', pub: base64Encode(publicKey), nonce: base64Encode(nonce) });
export const pairConfirmMessage = (mac: Bytes): HandshakeMessage => ({ t: 'pairConfirm', mac: base64Encode(mac) });
export const pairRejectMessage = (reason: string): HandshakeMessage => ({ t: 'pairReject', reason });
export const sessionStartMessage = (clientId: string, nonce: Bytes): HandshakeMessage => ({
  t: 'sessionStart',
  v: INSIGHT_PROTOCOL_VERSION,
  clientId,
  nonce: base64Encode(nonce),
});

export function encodeHandshake(message: HandshakeMessage): Bytes {
  try {
    return handshakeEnvelope(utf8Encode(JSON.stringify(message)));
  } catch {
    throw new BridgeError('encoding', null, 'handshake');
  }
}

/** The JSON object of a plaintext handshake envelope, `null` if it is not one. */
export function decodeHandshake(envelope: Bytes): HandshakeMessage | null {
  const body = handshakeBody(envelope);
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(utf8Decode(body));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A base64 field of a handshake message, optionally of an exact length. */
export function handshakeBytes(message: HandshakeMessage, key: string, length?: number): Bytes | null {
  const v = message[key];
  if (typeof v !== 'string') return null;
  const bytes = base64Decode(v);
  if (!bytes || (length !== undefined && bytes.length !== length)) return null;
  return bytes;
}
