/**
 * Byte-level tests for the FreeStyle Libre 3 driver. The vectors come from the MIT test suites of
 * RoundWhiteDiscKit (`Tests/RoundWhiteDiscKitTests`: AESCCM, BleFraming, DataPlane, NFCActivationCommand,
 * Libre3ReceiverID) and were produced with real sensors or the RFC; they are quoted here unchanged.
 */
import { concatBytes, fromHex, hex } from '@buddy/core';
import { describe, expect, it } from 'vitest';
import { ccmDecrypt, ccmEncrypt, CcmAuthError } from '../src/libre3/ccm';
import { PATCH_SIGNING_KEYS } from '../src/libre3/constants';
import { DataPlaneCrypto, channelForUuid, decodeDataPlane } from '../src/libre3/data-plane';
import { GlucoseNotificationAssembler, NotifyReassembler, fragmentForWrite, parseDataFrame, reassembleWrites } from '../src/libre3/framing';
import { verifySensorCertificate } from '../src/libre3/handshake';
import { backfillCommand, decodeHistoricalPage, eventLogCommand, factoryDataCommand, shutdownPatchCommand } from '../src/libre3/history';
import { SensorLifecycle, decodePatchStatus, sensorAttention, sensorError } from '../src/libre3/lifecycle';
import {
  abbottCrc16, accountlessReceiverId, activationParameters, parseActivationResponse, parsePatchInfo, receiverIdFromAccount, receiverIdToHex, parseReceiverIdHex,
} from '../src/libre3/nfc';
import { assessRealtime, dataQualityError, decodeRealtime, glucoseValueStatus } from '../src/libre3/realtime';

const patch = (h: string) => fromHex(h);
/** 140-byte sensor certificate captured during a fresh pair (RoundWhiteDiscKit BleFramingTests, phase 2). */
const CAPTURED_SENSOR_CERT = fromHex('0157259416c6007ae00550043e1f46f25d44b3d72a8c37dcfebc7c339ed01fc5668a6387458084ac9cafebe7438b649f76b81eeca9343287da162b07c5c07362997e40e13035df14cdf3d5d81a5fe9ffc84de8c8ecc33be609bf0d8ebf97bed6bae899e181bb32960c81e99d5aab30b2fc7a77b0d45eff9885d46722371cd9375e14352d890f60fa1e7159e6');
const withU16 = (b: Uint8Array, offset: number, v: number) => {
  const c = b.slice();
  c[offset] = v & 0xff;
  c[offset + 1] = v >> 8;
  return c;
};

describe('AES-CCM', () => {
  it('matches RFC 3610 packet vector #1 (M=8) and rejects tampering', () => {
    const key = fromHex('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf');
    const nonce = fromHex('00000003020100a0a1a2a3a4a5');
    const aad = fromHex('0001020304050607');
    const pt = fromHex('08090a0b0c0d0e0f101112131415161718191a1b1c1d1e');
    const { ciphertext, tag } = ccmEncrypt(key, nonce, pt, 8, aad);
    expect(hex(ciphertext)).toBe('588c979a61c663d2f066d0c2c0f989806d5f6b61dac384');
    expect(hex(tag)).toBe('17e8d12cfdf926e0');
    expect(ccmDecrypt(key, nonce, ciphertext, tag, aad)).toEqual(pt);
    const tampered = ciphertext.slice();
    tampered[0]! ^= 1;
    expect(() => ccmDecrypt(key, nonce, tampered, tag, aad)).toThrow(CcmAuthError);
  });
});

describe('BLE framing', () => {
  it('fragments writes into 18-byte chunks with a little-endian offset and reassembles them', () => {
    const message = Uint8Array.from({ length: 162 }, (_, i) => (i * 7 + 3) & 0xff);
    const fragments = fragmentForWrite(message);
    expect(fragments).toHaveLength(9);
    fragments.forEach((f, i) => {
      expect(f[0]! | (f[1]! << 8)).toBe(i * 18);
      expect(f.length - 2).toBeLessThanOrEqual(18);
    });
    expect(reassembleWrites(fragments)).toEqual(message);
  });

  it('reassembles the captured 140-byte sensor certificate from 19-byte notifications and detects sequence gaps', () => {
    const cert = CAPTURED_SENSOR_CERT;
    expect(cert.length).toBe(140);
    const reassembler = new NotifyReassembler();
    for (let i = 0, seq = 0; i < cert.length; i += 19, seq++) reassembler.feed(concatBytes(Uint8Array.of(seq), cert.subarray(i, i + 19)));
    expect(reassembler.available).toBe(140);
    expect(reassembler.take(140)).toEqual(cert);

    const gap = new NotifyReassembler();
    gap.feed(Uint8Array.of(0x00, 0xaa));
    expect(() => gap.feed(Uint8Array.of(0x02, 0xbb))).toThrow(/gap/);
    expect(() => gap.take(5)).toThrow();
  });

  it('parses the data-frame trailer', () => {
    const frame = parseDataFrame(fromHex('aabbccddee0700'));
    expect(hex(frame.encrypted)).toBe('aabbccddee');
    expect(frame.seq).toBe(7);
    expect(frame.sequenceNumber).toBe(7);
    expect(() => parseDataFrame(Uint8Array.of(1))).toThrow();
    expect(parseDataFrame(fromHex('ed7df1f64812b45afa57010100')).encrypted).toHaveLength(11);
  });

  it('joins the 15-byte glucose prefix with its suffix', () => {
    const assembler = new GlucoseNotificationAssembler();
    expect(assembler.feed(new Uint8Array(15).fill(1))).toBeNull();
    expect(assembler.feed(new Uint8Array(20).fill(2))).toHaveLength(35);
    expect(assembler.feed(new Uint8Array(18).fill(3))).toHaveLength(18);
  });
});

describe('sensor certificate', () => {
  it('verifies the captured fresh-pair certificate against the published patch-signing keys', () => {
    const cert = CAPTURED_SENSOR_CERT;
    expect(cert.length).toBe(140);
    const index = verifySensorCertificate(cert, PATCH_SIGNING_KEYS);
    expect(index).not.toBeNull();
  });

  it('rejects a certificate whose signed bytes changed', () => {
    const cert = new Uint8Array(140);
    cert[11] = 0x04;
    expect(verifySensorCertificate(cert, PATCH_SIGNING_KEYS)).toBeNull();
  });
});

describe('data plane', () => {
  const crypto = new DataPlaneCrypto(fromHex('7c536d2ec3c76c741a776de85596959d'), fromHex('00000000bcc696a2'));

  it('reassembles and decrypts a live glucoseData notification (prefix + suffix, kind 3)', () => {
    const assembler = new GlucoseNotificationAssembler();
    expect(assembler.feed(fromHex('3c937752c72e2dfdcfe05a5dce315b'))).toBeNull();
    const raw = assembler.feed(fromHex('6f3785f23dbc85066856d60027c5a41f45c90100'))!;
    const frame = parseDataFrame(raw);
    expect(frame.sequenceNumber).toBe(1);
    const packet = decodeDataPlane(crypto, 'glucoseData', frame);
    expect(packet.kind).toBe(3);
    expect(hex(crypto.decrypt(frame, 3))).toBe('da386700e3ff0000ac26c73871000b670071001a0abf03f33c59100000');
    expect(packet.payload.kind).toBe('realtime');
    if (packet.payload.kind === 'realtime') {
      expect(packet.payload.reading.lifeCount).toBe(14554);
      expect(packet.payload.reading.current).toEqual({ kind: 'valid', mgdl: 103 });
    }
  });

  it('decrypts live patchStatus (kind 2) and historicData (kind 4) frames', () => {
    const status = decodeDataPlane(crypto, 'patchStatus', parseDataFrame(fromHex('4e6fe9573b6365476193e9c42009acd20100')));
    expect(status.kind).toBe(2);
    expect(status.payload.kind === 'patchStatus' && status.payload.status).toMatchObject({ lifeCount: 10397, currentLifeCount: 14555, stackDisconnectReason: 22, appDisconnectReason: 7 });

    const page = decodeDataPlane(crypto, 'historicData', parseDataFrame(fromHex('4637aa722274876d69a34f20096c49adced70100')));
    expect(page.kind).toBe(4);
    expect(page.payload.kind === 'historicalPage' && page.payload.page.samples.map((s) => s.rawValue)).toEqual([109, 107, 105, 110, 106, 101]);
    expect(page.payload.kind === 'historicalPage' && page.payload.page.startLifeCount).toBe(920);
  });

  it('builds the nonce from sequence, descriptor and ivEnc, and round trips with descriptor search', () => {
    const c = new DataPlaneCrypto(fromHex('4bbce496a63cc9a435adeeb4f78e1617'), fromHex('0000000067c72c01'));
    expect(hex(c.nonce(1, 7))).toBe('01004400000000000067c72c01');
    const plaintext = fromHex('00112233445566778899aabb');
    const frame = parseDataFrame(c.encrypt(plaintext, 0x0201, 7));
    expect(frame.sequenceNumber).toBe(0x0201);
    expect(c.decrypt(frame, 7)).toEqual(plaintext);
    expect(c.decryptTryingAllKinds(frame)).toMatchObject({ kind: 7, plaintext });
    expect(() => c.decrypt(frame, 0)).toThrow(CcmAuthError);
  });

  it('builds the patchControl commands and a 13-byte encrypted write frame', () => {
    expect(hex(backfillCommand('historical', 5))).toBe('01000105000000');
    expect(hex(backfillCommand('clinical', 1))).toBe('01010101000000');
    expect(hex(backfillCommand('historical', 907))).toBe('0100018b030000');
    expect(hex(eventLogCommand(1))).toBe('04010000000000');
    expect(hex(factoryDataCommand())).toBe('06000000000000');
    expect(hex(shutdownPatchCommand())).toBe('05000000000000');
    const c = new DataPlaneCrypto(fromHex('4bbce496a63cc9a435adeeb4f78e1617'), fromHex('0000000067c72c01'));
    const write = c.encrypt(backfillCommand('historical', 5), 1, 0);
    expect(write).toHaveLength(13);
    expect(c.decrypt(parseDataFrame(write), 0)).toEqual(backfillCommand('historical', 5));
  });

  it('maps characteristic UUIDs to channels', () => {
    expect(channelForUuid('08981482-EF89-11E9-81B4-2A2AE2DBCCE4')).toBe('patchStatus');
    expect(channelForUuid('0898177a-ef89-11e9-81b4-2a2ae2dbcce4')).toBe('glucoseData');
    expect(channelForUuid('0898195A-EF89-11E9-81B4-2A2AE2DBCCE4')).toBe('historicData');
    expect(channelForUuid('0000fde3-0000-1000-8000-00805f9b34fb')).toBeNull();
  });
});

describe('realtime glucose decoding', () => {
  const base = patch('e3386200d6ff0000f023d1386c000b62006c00200a9e03113d03100000');

  it('decodes live plaintexts', () => {
    const cases = [
      { hex: 'e3386200d6ff0000f023d1386c000b62006c00200a9e03113d03100000', lc: 14563, mg: 98, rate: -0.42, temp: 2592 },
      { hex: 'e4386200d6ff0000f023d1386c000b62006c001f0a9b03093d0b100000', lc: 14564, mg: 98, rate: -0.42, temp: 2591 },
      { hex: 'e5386100d9ff00008c23d1386c000b61006c001e0a9403053d12100000', lc: 14565, mg: 97, rate: -0.39, temp: 2590 },
      { hex: 'e6386100daff00008c23d1386c000b61006c001d0a9203003dfb0f0000', lc: 14566, mg: 97, rate: -0.38, temp: 2589 },
    ];
    for (const c of cases) {
      const r = decodeRealtime(patch(c.hex));
      expect(r.lifeCount).toBe(c.lc);
      expect(r.current).toEqual({ kind: 'valid', mgdl: c.mg });
      expect(r.rateOfChange).toBeCloseTo(c.rate, 5);
      expect(r.dqError).toEqual({ kind: 'good' });
      expect(r.sensorCondition).toBe('ok');
      expect(r.trend).toBe('stable');
      expect(r.actionable).toBe(true);
      expect(r.historicalLifeCount).toBe(14545);
      expect(r.historical).toEqual({ kind: 'valid', mgdl: 108 });
      expect(r.temperature).toBe(c.temp);
      expect(assessRealtime(r, null).isUsable).toBe(true);
    }
  });

  it('applies the display range rules', () => {
    expect(decodeRealtime(withU16(base, 15, 38)).current).toEqual({ kind: 'belowRange', raw: 38, mgdl: 39 });
    expect(decodeRealtime(withU16(base, 15, 600)).current).toEqual({ kind: 'aboveRange', raw: 600, mgdl: 501 });
    expect(decodeRealtime(withU16(base, 15, 0)).current).toEqual({ kind: 'unavailable', raw: 0 });
    expect(decodeRealtime(withU16(base, 15, 1000)).current).toEqual({ kind: 'unavailable', raw: 1000 });
    expect(glucoseValueStatus(39)).toEqual({ kind: 'valid', mgdl: 39 });
    expect(glucoseValueStatus(501)).toEqual({ kind: 'valid', mgdl: 501 });
  });

  it('parses data-quality and sensor-condition bits and treats actionability as advisory', () => {
    const dq = decodeRealtime(withU16(base, 2, 0x8062));
    expect(dq.dqError).toEqual({ kind: 'notDisplayable', raw: 0x8062 });
    expect(assessRealtime(dq, null).isUsable).toBe(false);
    expect(dataQualityError(0xa001).kind).toBe('sensorTooHot');
    expect(dataQualityError(0xc001).kind).toBe('sensorTooCold');

    const cond = decodeRealtime(withU16(base, 2, 0x2062));
    expect(cond.sensorCondition).toBe('invalid');
    expect(assessRealtime(cond, null).blocking.map((i) => i.kind)).toEqual(['sensorCondition']);

    const notActionable = base.slice();
    notActionable[14] = 0x03;
    const na = assessRealtime(decodeRealtime(notActionable), null);
    expect(na.isUsable).toBe(true);
    expect(na.advisories.map((i) => i.kind)).toEqual(['notActionable']);
    expect(() => decodeRealtime(base.subarray(0, 28))).toThrow();
  });

  it('blocks warmup and expiry through the lifecycle', () => {
    const r = decodeRealtime(base);
    expect(assessRealtime(r, new SensorLifecycle(12, 60, 21600)).blocking).toEqual([{ kind: 'sensorWarmup', remainingMinutes: 48 }]);
    expect(assessRealtime(r, new SensorLifecycle(21600, 60, 21600)).blocking.map((i) => i.kind)).toEqual(['sensorExpired']);
    expect(assessRealtime(r, new SensorLifecycle(14563, 60, 21600)).isUsable).toBe(true);
  });
});

describe('patch status and lifecycle', () => {
  it('decodes the live record', () => {
    const s = decodePatchStatus(patch('9d280000e0000704e4381300'));
    expect(s).toMatchObject({ lifeCount: 10397, errorData: 0, eventData: 4224, index: 7, patchState: 4, currentLifeCount: 14564, stackDisconnectReason: 19, appDisconnectReason: 0 });
    const life = new SensorLifecycle(s.currentLifeCount, 60, 20160);
    expect(life.phase).toBe('active');
    expect(life.remainingWearMinutes).toBe(5596);
  });

  it('maps error codes and attention', () => {
    const status = (word: string) => decodePatchStatus(patch(`9d28${word}e0000704e4381300`));
    expect(['0000', '0300', '0500', '0600', '0700', '0800', '0900'].map((w) => status(w).sensorError)).toEqual(['none', 'insertionFailure', 'expired', 'terminated', 'transmissionError', 'terminated', 'unknown']);
    expect(['0000', '0300', '0500', '0600', '0700', '0800', '0900'].map((w) => status(w).attention)).toEqual(['none', 'checkSensor', 'sensorEnded', 'sensorEnded', 'checkSensor', 'replaceSensor', 'unknown']);
    expect(sensorError(8)).toBe('terminated');
    // LibreLoop: an error code on a sensor that is still active (state 4) is event-log history, only "check sensor"
    expect(status('0800').effectiveAttention).toBe('checkSensor');
  });

  it('falls back to the patch state when there is no error code', () => {
    expect([3, 5, 6, 7, 8, 4, 9].map((state) => sensorAttention(0, state))).toEqual(['checkSensor', 'sensorEnded', 'sensorEnded', 'replaceSensor', 'replaceSensor', 'none', 'none']);
    const ended = (state: number) => {
      const bytes = patch('9d280000e0000704e4381300');
      bytes[7] = state;
      return decodePatchStatus(bytes);
    };
    expect(ended(8).effectiveAttention).toBe('replaceSensor');
    expect(ended(6).effectiveAttention).toBe('sensorEnded');
  });

  it('takes warmup and wear from the NFC patch info', () => {
    const status = decodePatchStatus(patch('0c000000000000040c000000'));
    const info = parsePatchInfo(patch('00a50001000200010060541e020401040c04305252433938394151c6ca'));
    const life = new SensorLifecycle(status.currentLifeCount, info.warmupMinutes, info.wearDurationMinutes);
    expect(life.phase).toBe('warmup');
    expect(life.remainingWarmupMinutes).toBe(48);
    expect(life.remainingWearMinutes).toBe(21588);
  });
});

describe('historical pages', () => {
  it('decodes a live page with a 5-minute stride', () => {
    const page = decodeHistoricalPage(patch('8e0369006b006d006b0069006e00'));
    expect(page.startLifeCount).toBe(910);
    expect(page.endLifeCount).toBe(935);
    expect(page.samples.map((s) => [s.lifeCount, s.mgdl])).toEqual([[910, 105], [915, 107], [920, 109], [925, 107], [930, 105], [935, 110]]);
    expect(() => decodeHistoricalPage(new Uint8Array(13))).toThrow();
  });
});

describe('NFC layer', () => {
  it('computes the Abbott CRC and the activation / switch parameters from captured wire bytes', () => {
    expect(abbottCrc16(patch('fc2bee6978830d6f'))).toBe(0x71b4);
    expect(hex(activationParameters(1777216508, 0x6f0d8378))).toBe('fc2bee6978830d6fb471');
    expect(hex(activationParameters(1778097295, 0xc3251f23))).toBe('8f9cfb69231f25c3aac8');
    expect(hex(activationParameters(1778100341, 0x6f0d8378))).toBe('75a8fb6978830d6f4cd4');
  });

  it('parses fresh and active patch info, with or without CoreNFC padding', () => {
    const fresh = parsePatchInfo(patch('00a50001000200010060541e020401040c0130525243393839415151ff17'));
    expect(fresh).toMatchObject({ serialNumber: '0RRC989AQ', stateByte: 1, wearDurationMinutes: 21600, firmwareVersion: '1.4.2.30', generation: 1, productType: 4, warmupMinutes: 60, recommendedCommand: 0xa0 });
    const active = parsePatchInfo(patch('a50001000200010060541e020401040c04305252433938394151c6ca'));
    expect(active).toMatchObject({ stateByte: 4, recommendedCommand: 0xa8, serialNumber: '0RRC989AQ' });
    const padded = parsePatchInfo(patch('00a5a5a5a5a5a5a5a50001000200010060541e020401040c04305252433938394151c6ca'));
    expect(padded.serialNumber).toBe('0RRC989AQ');
    expect(() => parsePatchInfo(new Uint8Array(10))).toThrow(/invalidPatchInfo/);
  });

  it('parses activation and switch responses (BLE address, PIN boundary)', () => {
    const r = parseActivationResponse(patch('00a50058f9b8df22cc3225ec7200000000ad06'));
    expect(r.bleAddress).toBe('CC:22:DF:B8:F9:58');
    expect(hex(r.blePin)).toBe('3225ec72');
    expect(hex(r.activationTimeRaw)).toBe('00000000');
    expect(hex(parseActivationResponse(patch('a50058f9b8df22cc3225ec7200000000ad06')).blePin)).toBe('3225ec72');
    const sw = parseActivationResponse(patch('00a50058f9b8df22cc02bafbbbfc2bee698e6e'));
    expect(hex(sw.blePin)).toBe('02bafbbb');
    expect(hex(sw.activationTimeRaw)).toBe('fc2bee69');
    expect(() => parseActivationResponse(new Uint8Array(18))).toThrow(/invalidActivationResponse/);
  });

  it('derives receiver ids like the Abbott apps', () => {
    expect(accountlessReceiverId('5abb0ad8-dc2e-4ede-9e2d-67472a3e630e')).toBe(0x6f0d8378);
    expect(receiverIdToHex(accountlessReceiverId('6147368e-c060-44a5-9e96-1c02333f43c0'))).toBe('231f25c3');
    const sample = '2977dec2-492a-11ea-9702-0242ac110002';
    expect(receiverIdFromAccount(sample, 'freeStyleLibre3')).toBe(524_381_581);
    expect(receiverIdFromAccount(sample, 'libreByAbbott')).toBe(2_203_515_335);
    expect(receiverIdToHex(receiverIdFromAccount(sample, 'libreByAbbott'))).toBe('c7f95683');
    expect(receiverIdFromAccount(sample.toUpperCase(), 'libreByAbbott')).toBe(2_203_515_335);
    expect(receiverIdFromAccount('2977dec2-4', 'libreByAbbott')).toBe((0x32393737 + 0x64656332 + 0x2d34) >>> 0);
    expect(parseReceiverIdHex('78:83:0d:6f')).toBe(0x6f0d8378);
    expect(parseReceiverIdHex('0x78830d6f')).toBe(0x6f0d8378);
    expect(parseReceiverIdHex('zz')).toBeNull();
  });
});
