import { describe, expect, it } from 'vitest';
import { fromHex, hex } from '@buddy/core';
import vectors from './fixtures/insight-test-vectors.json';
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from '../src/insight/bytes';
import {
  commitment,
  confirmationCode,
  confirmMacBridge,
  confirmMacPhone,
  DIRECTION_BRIDGE_TO_PHONE,
  DIRECTION_PHONE_TO_BRIDGE,
  ecdhSharedSecret,
  EnvelopeCodec,
  EnvelopeError,
  gcmNonce,
  longTermKey,
  publicKeyFromPrivate,
  sessionKey,
  sessionMac,
  verifyMac,
  type Direction,
} from '../src/insight/crypto';
import { fragmentMessage, Reassembler } from '../src/insight/fragmentation';

const p = vectors.pairing;
const s = vectors.session;

describe('Insight crypto against the protocol test vectors', () => {
  it('derives the ephemeral keys and the ECDH secret', () => {
    expect(hex(publicKeyFromPrivate(fromHex(p.initiatorPrivateScalar)))).toBe(p.initiatorPublicKey);
    expect(hex(publicKeyFromPrivate(fromHex(p.bridgePrivateScalar)))).toBe(p.bridgePublicKey);
    expect(hex(ecdhSharedSecret(fromHex(p.initiatorPrivateScalar), fromHex(p.bridgePublicKey)))).toBe(p.sharedSecretZ);
    expect(hex(ecdhSharedSecret(fromHex(p.bridgePrivateScalar), fromHex(p.initiatorPublicKey)))).toBe(p.sharedSecretZ);
  });

  it('computes the commitment, LTK, SAS and confirmation MACs', () => {
    const pub = fromHex(p.initiatorPublicKey);
    expect(hex(commitment(pub, fromHex(p.nonceI)))).toBe(p.commitment.commit);
    expect(hex(commitment(pub, fromHex(p.commitment.wrongNonceI)))).toBe(p.commitment.commitWithWrongNonceI);
    const ltk = longTermKey(fromHex(p.sharedSecretZ), fromHex(p.nonceI), fromHex(p.nonceB));
    expect(hex(ltk)).toBe(p.ltk);
    expect(confirmationCode(ltk)).toBe(p.sas);
    expect(hex(confirmMacPhone(ltk))).toBe(p.pairConfirmMac);
    expect(hex(confirmMacBridge(ltk))).toBe(p.pairDoneMac);
    for (const c of vectors.sasCases) expect(confirmationCode(fromHex(c.ltk))).toBe(c.sas);
  });

  it('computes the session MAC and session key', () => {
    const ltk = fromHex(s.ltk);
    expect(hex(sessionMac(ltk, fromHex(s.nonceI), fromHex(s.nonceB)))).toBe(s.mac);
    expect(hex(sessionKey(ltk, fromHex(s.nonceI), fromHex(s.nonceB)))).toBe(s.sessionKey);
  });

  it('parses the vector handshake messages', () => {
    const resp = JSON.parse(s.messages.sessionResp) as { nonce: string; mac: string };
    expect(hex(base64Decode(resp.nonce)!)).toBe(s.nonceB);
    expect(hex(base64Decode(resp.mac)!)).toBe(s.mac);
    const start = JSON.parse(s.messages.sessionStart) as { nonce: string };
    expect(base64Encode(fromHex(s.nonceI))).toBe(start.nonce);
  });

  it('reproduces every envelope vector exactly and opens it in the other direction', () => {
    expect(vectors.envelopes.length).toBeGreaterThanOrEqual(4);
    for (const e of vectors.envelopes) {
      const key = fromHex(e.key);
      const direction = e.directionByte as Direction;
      expect(hex(gcmNonce(direction, e.counter))).toBe(e.nonce);
      const plaintext = fromHex(e.plaintextHex);
      expect(utf8Decode(plaintext)).toBe(e.plaintextUtf8);
      const sender = new EnvelopeCodec(key, direction, { sendCounter: e.counter - 1 });
      expect(hex(sender.seal(plaintext))).toBe(e.envelope);
      const receiverDirection = direction === DIRECTION_PHONE_TO_BRIDGE ? DIRECTION_BRIDGE_TO_PHONE : DIRECTION_PHONE_TO_BRIDGE;
      const receiver = new EnvelopeCodec(key, receiverDirection, { lastReceivedCounter: e.counter - 1 });
      expect(hex(receiver.open(fromHex(e.envelope)))).toBe(e.plaintextHex);
      expect(() => receiver.open(fromHex(e.envelope))).toThrowError(EnvelopeError); // replay
    }
  });

  it('rejects tampered, truncated and wrong-type envelopes without advancing the counter', () => {
    const e = vectors.envelopes.find((x) => x.directionByte === 2)!;
    const key = fromHex(e.key);
    const phone = new EnvelopeCodec(key, DIRECTION_PHONE_TO_BRIDGE, { lastReceivedCounter: e.counter - 1 });
    const tampered = fromHex(e.envelope);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => phone.open(tampered)).toThrowError(expect.objectContaining({ fault: 'authentication' }));
    const header = fromHex(e.envelope);
    header[3]! ^= 1; // counter bit flipped: AAD and nonce no longer match
    expect(() => phone.open(header)).toThrowError(EnvelopeError);
    expect(() => phone.open(fromHex(e.envelope).slice(0, 20))).toThrowError(expect.objectContaining({ fault: 'malformed' }));
    const wrongType = fromHex(e.envelope);
    wrongType[0] = 0x01;
    expect(() => phone.open(wrongType)).toThrowError(expect.objectContaining({ fault: 'malformed' }));
    // the genuine envelope is still accepted afterwards
    expect(hex(phone.open(fromHex(e.envelope)))).toBe(e.plaintextHex);
  });

  it('counts up from 1 and never reuses a counter', () => {
    const key = fromHex(s.sessionKey);
    const a = new EnvelopeCodec(key, DIRECTION_PHONE_TO_BRIDGE);
    const b = new EnvelopeCodec(key, DIRECTION_BRIDGE_TO_PHONE);
    const e1 = a.seal(utf8Encode('one'));
    const e2 = a.seal(utf8Encode('two'));
    expect(a.lastSentCounter).toBe(2);
    expect(e1[8]).toBe(1);
    expect(e2[8]).toBe(2);
    expect(utf8Decode(b.open(e1))).toBe('one');
    expect(() => b.open(e1)).toThrowError(expect.objectContaining({ fault: 'replay' }));
    expect(utf8Decode(b.open(e2))).toBe('two');
  });

  it('compares MACs in constant time semantics (length and content)', () => {
    expect(verifyMac(fromHex('aabb'), fromHex('aabb'))).toBe(true);
    expect(verifyMac(fromHex('aabb'), fromHex('aabc'))).toBe(false);
    expect(verifyMac(fromHex('aa'), fromHex('aabb'))).toBe(false);
  });
});

describe('Insight fragmentation', () => {
  const check = (v: { maxFragmentSize: number; messageSeq: number; message: string; fragments: string[] }) => {
    const message = fromHex(v.message);
    const ours = fragmentMessage(message, v.messageSeq, v.maxFragmentSize)!;
    expect(ours.map(hex)).toEqual(v.fragments);
    const r = new Reassembler();
    let last = r.accept(fromHex(v.fragments[0]!), 0);
    for (const f of v.fragments.slice(1)) last = r.accept(fromHex(f), 0);
    expect(last).toEqual({ kind: 'complete', message });
  };
  it('matches the bridge vectors (multi and single fragment)', () => {
    check(vectors.fragmentation);
    check(vectors.fragmentationSingle);
  });

  it('refuses empty, oversized and unusable fragment sizes', () => {
    expect(fragmentMessage(new Uint8Array(0), 1, 20)).toBeNull();
    expect(fragmentMessage(new Uint8Array(16 * 1024 + 1), 1, 20)).toBeNull();
    expect(fragmentMessage(new Uint8Array(5), 1, 3)).toBeNull();
  });

  it('starts over on a new FIRST fragment, drops mismatches and stale partials', () => {
    const r = new Reassembler(5000);
    const a = fragmentMessage(new Uint8Array(30).fill(1), 1, 13)!;
    const b = fragmentMessage(new Uint8Array(4).fill(2), 2, 20)!;
    expect(r.accept(a[0]!, 0).kind).toBe('incomplete');
    expect(r.accept(b[0]!, 10)).toEqual({ kind: 'complete', message: new Uint8Array(4).fill(2) });
    expect(r.accept(a[1]!, 20)).toEqual({ kind: 'dropped', reason: 'continuation without start' });
    expect(r.accept(a[0]!, 30).kind).toBe('incomplete');
    const other = fragmentMessage(new Uint8Array(30).fill(3), 9, 13)!;
    expect(r.accept(other[1]!, 40)).toEqual({ kind: 'dropped', reason: 'sequence mismatch' });
    expect(r.accept(a[0]!, 50).kind).toBe('incomplete');
    expect(r.accept(a[1]!, 50 + 6000)).toEqual({ kind: 'dropped', reason: 'continuation without start' });
  });

  it('reports messages above the size limit', () => {
    const r = new Reassembler(5000, 10);
    const f = fragmentMessage(new Uint8Array(30).fill(1), 1, 13)!;
    expect(r.accept(f[0]!, 0).kind).toBe('incomplete');
    expect(r.accept(f[1]!, 0).kind).toBe('tooLarge');
    expect(r.isAssembling).toBe(false);
  });
});
