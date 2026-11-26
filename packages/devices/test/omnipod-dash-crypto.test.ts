/**
 * DASH link crypto and framing against vectors from OmnipodKit's tests
 * (MIT License, (c) LoopKit Authors): DashKeyExchangeTests, EnDecryptTests, MessagePacketTests,
 * PayloadSplitterTest, PayloadJoinerTest, StringLengthPrefixEncodingTests; plus the 3GPP TS 35.208
 * MILENAGE test set 1 (the pod uses that test set's OP and AMF).
 */
import { describe, expect, it } from 'vitest';
import { fromHex, hex } from '@buddy/core';
import { aesCcmDecrypt, aesCcmEncrypt, aesCmac } from '../src/omnipod/dash/crypto';
import { crc32 } from '../src/omnipod/dash/crc32';
import { PayloadJoiner, splitPayload } from '../src/omnipod/dash/ble-packets';
import { DashKeyExchange } from '../src/omnipod/dash/key-exchange';
import { makeEnDecrypt, nonceFor } from '../src/omnipod/dash/endecrypt';
import { encodeMessagePacket, makePacket, MessageType, parseMessagePacket } from '../src/omnipod/dash/message-packet';
import { formatKeys, parseKeys } from '../src/omnipod/dash/string-prefix';
import { eapSqnBytes, eapSqnToInt, milenage } from '../src/omnipod/dash/milenage';
import { encodeEap, parseEap, rand as eapRand, autn as eapAutn, customIv, res as eapRes, EapCode, EapAttr, findAttribute } from '../src/omnipod/dash/eap';

const stripCommas = (s: string): string => s.replace(/,/g, '');

describe('AES primitives', () => {
  it('computes AES-CMAC (RFC 4493 examples)', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
    expect(hex(aesCmac(key, new Uint8Array(0)))).toBe('bb1d6929e95937287fa37d129b756746');
    expect(hex(aesCmac(key, fromHex('6bc1bee22e409f96e93d7e117393172a')))).toBe('070a16b46b4d4144f79bdd9dd04a287c');
  });

  it('round-trips AES-CCM and rejects tampering', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f');
    const nonce = fromHex('00112233445566778899aabbcc');
    const aad = fromHex('0102030405060708');
    const plain = fromHex('c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3');
    const sealed = aesCcmEncrypt(key, nonce, aad, plain);
    expect(sealed).toHaveLength(plain.length + 8);
    expect(hex(aesCcmDecrypt(key, nonce, aad, sealed))).toBe(hex(plain));
    const tampered = sealed.slice();
    tampered[0] = tampered[0]! ^ 1;
    expect(() => aesCcmDecrypt(key, nonce, aad, tampered)).toThrow(/tag/i);
    expect(() => aesCcmDecrypt(key, nonce, fromHex('00'), sealed)).toThrow(/tag/i);
  });

  it('matches RFC 3610 packet vector #1 (13 byte nonce, 8 byte tag)', () => {
    const key = fromHex('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf');
    const nonce = fromHex('00000003020100a0a1a2a3a4a5');
    const aad = fromHex('0001020304050607');
    const plain = fromHex('08090a0b0c0d0e0f101112131415161718191a1b1c1d1e');
    const expected = '588c979a61c663d2f066d0c2c0f989806d5f6b61dac38417e8d12cfdf926e0';
    expect(hex(aesCcmEncrypt(key, nonce, aad, plain, 8))).toBe(expected);
  });
});

describe('EnDecrypt (vectors from OmnipodKit EnDecryptTests)', () => {
  it('decrypts a pod message', () => {
    const received = stripCommas('54,57,11,a1,0c,16,03,00,08,20,2e,a9,08,20,2e,a8,34,7c,b9,7b,38,5d,45,a3,c4,0e,40,4c,55,71,5e,f3,c3,86,50,17,36,7e,62,3c,7d,0b,46,9e,81,cd,fd,9a');
    const expected = stripCommas('30,2e,30,3d,00,12,08,20,2e,a9,1c,0a,1d,05,00,16,b0,00,00,00,0b,ff,01,fe');
    const ed = makeEnDecrypt(fromHex(stripCommas('6c,ff,5d,18,b7,61,6c,ae')), fromHex(stripCommas('55,79,9f,d2,66,64,cb,f6,e4,76,52,5e,2d,ee,52,c6')));
    const msg = parseMessagePacket(fromHex(received));
    expect(hex(ed.decrypt(msg, 23).payload)).toBe(expected);
  });

  it('encrypts a controller command', () => {
    const ed = makeEnDecrypt(fromHex('dda23c090a0a0a0a'), fromHex('ba1283744b6de9fab6d9b77d95a71d6e'));
    const expected = '54571101070003400242000002420001' + 'e09158bcb0285a81bf30635f3a17ee73f0afbb3286bc524a8a66' + 'fb1bc5b001e56543';
    const template = parseMessagePacket(fromHex(expected));
    const plain = { ...template, payload: fromHex('53302e303d000effffffff00060704ffffffff82b22c47302e30') };
    expect(hex(encodeMessagePacket(ed.encrypt(plain, 1)))).toBe(expected);
  });

  it('derives direction dependent nonces', () => {
    const prefix = fromHex('0102030405060708');
    expect(hex(nonceFor(prefix, 1, true))).toBe('01020304050607080000000001');
    expect(hex(nonceFor(prefix, 1, false))).toBe('01020304050607088000000001');
  });
});

describe('DashKeyExchange (OmnipodKit DashKeyExchangeTests)', () => {
  it('derives the LTK and confirmations from fixed keys', () => {
    const ke = new DashKeyExchange({
      nonce: fromHex('edfdacb242c7f4e1d2bc4d93ca3c5706'),
      privateKey: fromHex('27ec94b71a201c5e92698d668806ae5ba00594c307cf5566e60c1fc53a6f6bb6'),
    });
    ke.updatePodPublicData(fromHex('2fe57da347cd62431528daac5fbb290730fff684afc4cfc2ed90995f58cb3b74' + '00000000000000000000000000000000'));
    expect(hex(ke.pdmPublic)).toBe('f2b6940243aba536a66e19fb9a39e37f1e76a1cd50ab59b3e05313b4fc93975e');
    expect(hex(ke.pdmConf)).toBe('5fc3b4da865e838ceaf1e9e8bb85d1ac');
    ke.validatePodConf(fromHex('af4f10db5f96e5d9cd6cfc1f54f4a92f'));
    expect(hex(ke.ltk)).toBe('341e16d13f1cbf73b19d1c2964fee02b');
    expect(() => ke.validatePodConf(fromHex('af4f10db5f96e5d9cd6cfc1f54f4a92e'))).toThrow(/podConf/);
  });
});

describe('message packets and framing', () => {
  const payloadString = stripCommas('54,57,11,01,07,00,03,40,08,20,2e,a8,08,20,2e,a9,ab,35,d8,31,60,9b,b8,fe,3a,3b,de,5b,18,37,24,9a,16,db,f8,e4,d3,05,e9,75,dc,81,7c,37,07,cc,41,5f,af,8a');

  it('parses and re-serialises a message packet', () => {
    const msg = parseMessagePacket(fromHex(payloadString));
    expect(msg).toMatchObject({ type: MessageType.ENCRYPTED, source: 136326824, destination: 136326825, sequenceNumber: 7, ackNumber: 0, eqos: 1, priority: false, lastMessage: false, gateway: false, sas: true, tfs: false, version: 0 });
    expect(hex(msg.payload)).toBe(payloadString.slice(32));
    expect(hex(encodeMessagePacket(msg))).toBe(payloadString);
  });

  it('builds the pairing header', () => {
    const p = makePacket({ type: MessageType.PAIRING, source: 0x1781fc00, destination: 0xfffffffe, payload: new Uint8Array([1, 2]), sequenceNumber: 1 });
    expect(hex(encodeMessagePacket(p)).slice(0, 16)).toBe('5457100301000040');
    expect(parseMessagePacket(encodeMessagePacket(p)).payload).toEqual(new Uint8Array([1, 2]));
  });

  it('rejects wrong magic, short headers and truncated payloads', () => {
    expect(() => parseMessagePacket(fromHex('54'))).toThrow();
    expect(() => parseMessagePacket(fromHex('00'.repeat(16)))).toThrow(/Magic/);
    expect(() => parseMessagePacket(fromHex(payloadString.slice(0, 60)))).toThrow();
  });

  it('computes the CRC32 used by the BLE packets', () => {
    expect(crc32(fromHex(stripCommas('54,57,10,23,03,00,00,c0,ff,ff,ff,fe,08,20,2e,a8,50,30,3d,00,01,a5')))).toBe(0xbc201ff6);
  });

  it('splits and joins a payload across two packets (OmnipodKit splitter/joiner tests)', () => {
    const f1 = stripCommas('00,01,54,57,10,23,03,00,00,c0,ff,ff,ff,fe,08,20,2e,a8,50,30');
    const f2 = stripCommas('01,04,bc,20,1f,f6,3d,00,01,a5,ff,ff,ff,fe,08,20,2e,a8,50,30');
    const payload = fromHex(stripCommas('54,57,10,23,03,00,00,c0,ff,ff,ff,fe,08,20,2e,a8,50,30,3d,00,01,a5'));
    const packets = splitPayload(payload);
    expect(packets).toHaveLength(2);
    expect(hex(packets[0]!)).toBe(f1);
    expect(hex(packets[1]!).slice(0, 20)).toBe(f2.slice(0, 20));
    const joiner = new PayloadJoiner(fromHex(f1));
    joiner.accumulate(fromHex(f2));
    expect(hex(joiner.finalize())).toBe(hex(payload));
  });

  it('round-trips payloads of every size up to the DASH limit', () => {
    for (let len = 1; len <= 250; len++) {
      const payload = Uint8Array.from({ length: len }, (_, i) => (i * 7 + len) & 0xff);
      const packets = splitPayload(payload);
      const joiner = new PayloadJoiner(packets[0]!);
      expect(joiner.fullFragments).toBeLessThanOrEqual(packets.length - 1);
      for (const p of packets.slice(1)) joiner.accumulate(p);
      expect(hex(joiner.finalize())).toBe(hex(payload));
    }
  });

  it('detects out of order packets and corrupted payloads', () => {
    const payload = Uint8Array.from({ length: 60 }, (_, i) => i);
    const packets = splitPayload(payload);
    const joiner = new PayloadJoiner(packets[0]!);
    expect(() => joiner.accumulate(packets[2]!)).toThrow(/expected index 1/);
    const j2 = new PayloadJoiner(packets[0]!);
    const bad = packets.slice(1).map((p, i) => (i === 0 ? Uint8Array.from(p, (v, k) => (k === 5 ? v ^ 1 : v)) : p));
    bad.forEach((p) => j2.accumulate(p));
    expect(() => j2.finalize()).toThrow(/CRC/);
  });

  it('formats and parses length-prefixed keys', () => {
    const content = fromHex('a5');
    expect(hex(formatKeys(['P0='], [content]))).toBe('50303d0001a5');
    expect(parseKeys(['P0='], fromHex('50303d0001a5'))[0]).toEqual(content);
    expect(hex(formatKeys(['SP0,GP0'], [new Uint8Array(0)]))).toBe(hex(new TextEncoder().encode('SP0,GP0')));
    expect(() => parseKeys(['P1='], fromHex('50303d0001a5'))).toThrow(/Key not found/);
  });
});

describe('MILENAGE and EAP-AKA', () => {
  it('matches 3GPP TS 35.208 test set 1', () => {
    const m = milenage({
      k: fromHex('465b5ce8b199b49faa5f0a2ee238a6bc'),
      rand: fromHex('23553cbe9637a89d218ae64dae47bf35'),
      sqn: fromHex('ff9bb4d0b607'),
    });
    expect(hex(m.res)).toBe('a54211d5e3ba50bf');
    expect(hex(m.ck)).toBe('b40ba9a3c58b2a05bbf0d987b21bf8cb');
    expect(hex(m.ak)).toBe('aa689c648370');
    expect(hex(m.autn)).toBe('55f328b43577b9b94a9ffac354dfafb3');
  });

  it('recovers the SQN of a resynchronisation (AUTS)', () => {
    const k = fromHex('465b5ce8b199b49faa5f0a2ee238a6bc');
    const rand = fromHex('23553cbe9637a89d218ae64dae47bf35');
    const podSqn = eapSqnBytes(42);
    const pod = milenage({ k, rand, sqn: podSqn, amf: fromHex('0000') });
    const auts = new Uint8Array([...pod.akStar.map((v, i) => v ^ podSqn[i]!), ...pod.macS]);
    const ctrl = milenage({ k, rand, sqn: eapSqnBytes(3), auts });
    expect(eapSqnToInt(ctrl.synchronizationSqn)).toBe(42);
    const check = milenage({ k, rand, sqn: ctrl.synchronizationSqn, auts, amf: fromHex('0000') });
    expect(hex(check.macS)).toBe(hex(check.receivedMacS));
  });

  it('encodes and parses EAP messages', () => {
    const msg = { code: EapCode.REQUEST, identifier: 0, subType: 0, attributes: [eapAutn(new Uint8Array(16).fill(2)), eapRand(new Uint8Array(16).fill(1)), customIv(fromHex('01020304'))] };
    const bytes = encodeEap(msg);
    expect(hex(bytes).slice(0, 16)).toBe('0100003817010000');
    const back = parseEap(bytes);
    expect(back.code).toBe(EapCode.REQUEST);
    expect(back.attributes.map((a) => a.type)).toEqual([EapAttr.AUTN, EapAttr.RAND, EapAttr.CUSTOM_IV]);
    expect(findAttribute(back, EapAttr.CUSTOM_IV)?.payload).toEqual(fromHex('01020304'));
    const resp = parseEap(encodeEap({ code: EapCode.RESPONSE, identifier: 0, subType: 0, attributes: [eapRes(new Uint8Array(8).fill(9)), customIv(fromHex('0a0b0c0d'))] }));
    expect(findAttribute(resp, EapAttr.RES)?.payload).toEqual(new Uint8Array(8).fill(9));
    expect(hex(encodeEap({ code: EapCode.SUCCESS, identifier: 0, subType: 0, attributes: [] }))).toBe('03000004');
    expect(parseEap(fromHex('03000004')).code).toBe(EapCode.SUCCESS);
    expect(() => parseEap(fromHex('0100003c'))).toThrow();
  });
});
