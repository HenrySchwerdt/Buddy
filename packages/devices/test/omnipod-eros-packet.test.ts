/** Eros packet layer: vectors from OmnipodKit's PacketTests, CRC8Tests, CRC16Tests, MessageTests and NonceState. */
import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, hex } from '@buddy/core';
import {
  advanceNonce,
  createNonceState,
  crc16,
  crc8,
  currentNonce,
  decodePacket,
  encodeMessageFrame,
  encodePacket,
  fragmentMessage,
  generatePodAddress,
  inspectMessage,
  makePacket,
  PacketError,
  PacketType,
  resyncNonceState,
} from '../src/omnipod/eros';

const LONG = fromHex(
  '02cb5000c92162368024632d8029623f002c62320031623b003463320039633d003c63310041623e0044633200496340004c6333005163448101627c8104627c8109627c810c62198111627c811460198103fe',
);

describe('CRC', () => {
  it('crc8 matches OmnipodKit', () => {
    expect(crc8(fromHex('1f07b1eeae1f07b1ee181f1a0eeb5701b202010a0101a000340034170d000208000186a0'))).toBe(0x19);
  });
  it('crc16 matches OmnipodKit', () => {
    expect(crc16(fromHex('1f01482a10030e0100'))).toBe(0x802c);
  });
});

describe('Packet', () => {
  it('encodes a PDM packet', () => {
    const p = makePacket(0x1f01482a, PacketType.pdm, 13, fromHex('1f01482a10030e0100802c'));
    expect(hex(encodePacket(p))).toBe('1f01482aad1f01482a10030e0100802c88');
    expect(hex(p.data)).toBe('1f01482a10030e0100802c');
  });
  it('decodes a PDM packet', () => {
    const p = decodePacket(fromHex('1f01482aad1f01482a10030e0100802c88'));
    expect(p).toMatchObject({ address: 0x1f01482a, sequenceNum: 13, packetType: PacketType.pdm });
    expect(hex(p.data)).toBe('1f01482a10030e0100802c');
  });
  it('rejects short, corrupted and unknown-type packets', () => {
    expect(() => decodePacket(fromHex('1f01482aad'))).toThrow(PacketError);
    const bad = fromHex('1f01482aad1f01482a10030e0100802c89');
    expect(() => decodePacket(bad)).toThrowError(expect.objectContaining({ kind: 'crcMismatch' }));
    const unknown = fromHex('1f01482a0000');
    expect(() => decodePacket(concatBytes(unknown, Uint8Array.of(0)))).toThrowError(expect.objectContaining({ kind: 'unknownPacketType' }));
  });
  it('truncates ack bodies to 4 bytes', () => {
    expect(makePacket(1, PacketType.ack, 0, new Uint8Array(9)).data).toHaveLength(4);
  });
  it('fragments like PacketTests and round-trips', () => {
    const parts = fragmentMessage(LONG);
    expect(parts.map((p) => p.length)).toEqual([31, 31, 21]);
    expect(hex(parts[0]!)).toBe('02cb5000c92162368024632d8029623f002c62320031623b00346332003963');
    expect(hex(parts[2]!)).toBe('627c8109627c810c62198111627c811460198103fe');
    expect(concatBytes(...parts)).toEqual(LONG);
  });
  it('round-trips every body length for each type', () => {
    for (const type of [PacketType.pdm, PacketType.con, PacketType.pod]) {
      for (let n = 1; n <= 31; n++) {
        const data = Uint8Array.from({ length: n }, (_, i) => i * 7);
        expect(decodePacket(encodePacket(makePacket(0xdeadbeef, type, 31, data)))).toEqual({ address: 0xdeadbeef, packetType: type, sequenceNum: 31, data });
      }
    }
  });
});

describe('message frame', () => {
  it('accepts the OmnipodKit GetStatus and StatusResponse messages', () => {
    expect(inspectMessage(fromHex('1f01482a10030e0100802c'))).toEqual({ status: 'ok', address: 0x1f01482a, sequenceNum: 4, expectFollowOn: false, bodyLength: 3 });
    expect(inspectMessage(fromHex('1f00ee84300a1d18003f1800004297ff8128'))).toMatchObject({ status: 'ok', sequenceNum: 12, address: 0x1f00ee84 });
  });
  it('detects incomplete and corrupted messages', () => {
    expect(inspectMessage(fromHex('1f00ee84300a1d18003f18')).status).toBe('notEnoughData');
    expect(inspectMessage(fromHex('1f00ee84')).status).toBe('notEnoughData');
    expect(inspectMessage(fromHex('1f00ee84300a1d18003f1800004297ff8129')).status).toBe('invalidCrc');
  });
  it('encodeMessageFrame reproduces the GetStatus vector', () => {
    expect(hex(encodeMessageFrame({ address: 0x1f01482a, sequenceNum: 4, body: fromHex('0e0100') }))).toBe('1f01482a10030e0100802c');
  });
});

describe('nonce generator (vectors generated from OmnipodKit NonceState.swift)', () => {
  const run = (lot: number, tid: number, seed: number, n = 6) => {
    let s = createNonceState(lot, tid, seed);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(currentNonce(s).toString(16));
      s = advanceNonce(s);
    }
    return out;
  };
  it('lot 42560 tid 621607: matches the real pod nonce 0xbed2e16b seen in MessageTests', () => {
    const s = createNonceState(42560, 621607);
    expect(s.idx).toBe(11);
    expect(s.table.slice(0, 4).map((x) => x.toString(16))).toEqual(['37aba728', '1c3a13e3', 'bed2e16b', '1ac89be1']);
    expect(run(42560, 621607, 0)).toEqual(['c8a1e987', 'e3955e60', 'bed2e16b', 'b76fae1a', 'f35ee478', '1e7ca404']);
  });
  it('seeded and edge-case states', () => {
    expect(run(42560, 621607, 0x1234)).toEqual(['ebed2135', '43abc331', 'f44a3eb', '74b4bbd9', 'd65cc48f', 'aead03d8']);
    expect(run(0, 0, 0)).toEqual(['851072aa', 'f79bc46f', '5f4e351c', 'b170207', '6621b43f', 'abea97ee']);
    expect(run(0xffffffff, 0xffffffff, 0xffff)).toEqual(['b48afd8c', '1640d39c', 'ac93457f', 'e983d39f', '883d796d', '79001027']);
    expect(run(1234567, 7654321, 0xabcd)).toEqual(['f6d2c5a4', '7a131158', '8dbf172c', '15503cf9', 'b758959a', 'ed5024d1']);
  });
  it('advance does not mutate the previous state', () => {
    const s = createNonceState(1, 2);
    const before = [...s.table];
    advanceNonce(s);
    expect(s.table).toEqual(before);
  });
  it('resync reseeds from lot/tid, sync word and the rejected nonce', () => {
    const r = resyncNonceState({ lot: 42560, tid: 621607, syncWord: 0, sentNonce: 0, messageSequenceNum: 0 });
    // sum = crc16Table[0](0) + lot&0xffff + tid&0xffff ; seed = sum ^ 0
    const expectedSeed = (42560 + (621607 & 0xffff)) & 0xffff;
    expect(r).toEqual(createNonceState(42560, 621607, expectedSeed));
  });
});

describe('address', () => {
  it('generates 0x1f0xxxxx ids', () => {
    expect(generatePodAddress(() => 0xffffffff)).toBe(0x1f0fffff);
    expect(generatePodAddress(() => 0x12345678)).toBe(0x1f045678);
  });
});
