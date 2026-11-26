/**
 * Syai Ultra protocol tests. Vectors and cases are ported from the SyaiKitTests of SyaiKit
 * (MIT, © 2026 Nightscout Foundation): CRC16Tests, SyaiNotifyInfoTests, SyaiTransportTests,
 * SyaiGlucoseDecoderTests, SyaiCoefficientDecipherTests, SyaiApplicatorCodeTests,
 * SyaiBackfillGridTests, SyaiPlausibilityGuardTests, SyaiSensorLifecycleTests, and the real
 * V1.6 / V1.7 ground-truth captures of SyaiGroundTruthDBTests (a sample of each).
 */
import { describe, expect, it } from 'vitest';
import { fromHex, hex } from '@buddy/core';
import { ecb } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  advertisedMac,
  appParamBlob,
  appSignature,
  ATTENTION_COUNT0,
  backfillRange,
  base64Decode,
  base64Encode,
  computeLifecycle,
  crc16Modbus,
  currentTimeDigestEncoding,
  decipherCoefficients,
  decipherKeyGroup,
  decodeGlucose,
  decodeNotifyInfo,
  decryptOrg,
  deriveWrapKey,
  DecodeError,
  evaluateProgram,
  evaluateStatement,
  firstBackfillableSequence,
  fitsOnePacket,
  GLUCOSE_PROGRAM,
  isOnForwardGrid,
  isVerifiedParseVersion,
  keyAt,
  macBytes,
  macFromApplicatorCode,
  maxBackfillRequestCount,
  MMOL_TO_MGDL,
  packetInfo,
  parseCoefficients,
  parseDeviceParams,
  parseVersionForDevice,
  PlausibilityGuard,
  rawChannels,
  recordLength,
  reasonName,
  sessionKeyFromSharedSecretX,
  splitRecords,
  verifyDeviceSignature,
} from '../src/syai';

const V16_COEFFICIENTS = [0.1, 0.5, 18.5, 0.0, -0.0016, 0.5053, 0.1458, 0.015, 1.05, 0.8, 1.05, 0.025, 172_800.0, 1.0];
const V17_COEFFICIENTS = [0.1, 0.5, 18.5, 0.0, -0.0014, 0.5212, -0.2606, 0.015, 0.95, 0.8, 1.1, 0.05, 172_800.0, 1.0];
const DEFAULT_COEFFICIENTS = [0.1, 0.5, 18.5, 0.0, -0.0018, 0.5337, -0.0163, 0.015, 0.95, 1.0, 1.05, 0.025, 172_800.0, 1.0];

/** [framed-less origin record (hex, with the `0000 index` prefix), elapsed s, raw current, glucose mmol/L] from the live-DB pulls. */
type Vec = readonly [string, number, number, number];
const V16_VECTORS: readonly Vec[] = [
  ['0000c3039d3b4e78f0e1c056', 57840, 15261, 7.8],
  ['0000870778384a78e3c34155', 115683, 14456, 7.4],
  ['00004a0b1460807897a5c24e', 173463, 24596, 12.8],
  ['00000e0fea3f51788787c355', 231303, 16362, 8.1],
  ['0000d11274485c783b698454', 289083, 18548, 9.2],
  ['000095165e88ab782b4b4553', 346923, 34910, 17.1],
  ['0000581a453e5178df2c0653', 404703, 15941, 8.1],
  ['00001c1eb7698978cf0e4751', 462543, 27063, 13.7],
  ['0000e02180324678bff0074f', 520383, 12928, 7.0],
  ['0000a3253a53657873d2c857', 578163, 21306, 10.1],
  ['000067295066867868b44950', 636008, 26192, 13.4],
  ['00002a2dab3950781c968a4e', 693788, 14763, 8.0],
  ['0000ee30cb3747780c780b56', 751628, 14283, 7.1],
  ['0000b1340a6c9c78c059cc47', 809408, 27658, 15.6],
  ['00007538c6476178b03bcd4e', 867248, 18374, 9.7],
  ['0000383cec283b78641d8e4e', 925028, 10476, 5.9],
  ['0000fc3f7879987854ffce53', 982868, 31096, 15.2],
  ['0000c043b56b867844e1cf54', 1040708, 27573, 13.4],
  ['00008347c12d3a78f8c21059', 1098488, 11713, 5.8],
  ['0000474b144b6178e8a4d152', 1156328, 19220, 9.7],
  ['00000a4f8f3e51789c861254', 1214108, 16015, 8.1],
  ['0000ce52913041788c68d352', 1271948, 12433, 6.5],
  ['000091563b435c78484ad44d', 1329736, 17211, 9.2],
  ['0000555a7e2a4278382c1547', 1387576, 10878, 6.6],
  ['0000185eba364b78ec0d964f', 1445356, 14010, 7.5],
  ['0000dc6137435978dcefd650', 1503196, 17207, 8.9],
];
const V17_VECTORS: readonly Vec[] = [
  ['000001008a477cf1e901008c0c', 122, 18314, 9.5],
  ['000009003a3108f1690900880c', 602, 12602, 6.6],
  ['000012008d3004f1d91100ac0c', 1142, 12429, 6.5],
  ['00001b00e73108f1491a00a00c', 1682, 12775, 6.6],
  ['00002400003518f1b92200990c', 2222, 13568, 7.0],
  ['00002d00ce3314f1292b00a10c', 2762, 13262, 6.9],
  ['00003600983108f1993300a00c', 3302, 12696, 6.6],
  ['00003f006a3620f1093c00ae0c', 3842, 13930, 7.2],
  ['00004800783828f1794400af0c', 4382, 14456, 7.4],
  ['000051004f3a30f1e94c00e10c', 4922, 14927, 7.6],
  ['00005a00d73d40f1595500f50c', 5462, 15831, 8.0],
  ['00006300f33c40f1c95d00a60c', 6002, 15603, 8.0],
  ['00006c009b3e40f1396600fe0c', 6542, 16027, 8.0],
  ['000075006b4048f1a96e000b0d', 7082, 16491, 8.2],
  ['00007d00873f50f12976007c0c', 7562, 16263, 8.4],
  ['00008600b33e4ce1997e00920c', 8102, 16051, 8.3],
  ['00008f00353e48e1098700850c', 8642, 15925, 8.2],
  ['00009800b4435ce1798f00e90c', 9182, 17332, 8.7],
  ['0000a100054c84e1e99700110d', 9722, 19461, 9.7],
  ['0000aa00e54b94e159a0006e0c', 10262, 19429, 10.1],
  ['0000b300584b88e1c9a800c10c', 10802, 19288, 9.8],
  ['0000bc00e54674e139b100a50c', 11342, 18149, 9.3],
  ['0000c500004154e1a9b900bc0c', 11882, 16640, 8.5],
  ['0000ce00903834e119c200200c', 12422, 14480, 7.7],
  ['0000d700d8362ce189ca00300c', 12962, 14040, 7.5],
  ['0000e000ce3834e1f9d200440c', 13502, 14542, 7.7],
  ['0000e9000f3c44e169db00310c', 14042, 15375, 8.1],
  ['0000f200b73d54e1d9e300080c', 14582, 15799, 8.5],
];

describe('byte helpers', () => {
  it('base64 round trips and rejects garbage', () => {
    expect(base64Encode(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy');
    expect(base64Encode(new TextEncoder().encode('foob'))).toBe('Zm9vYg==');
    expect(new TextDecoder().decode(base64Decode('Zm9vYg==')!)).toBe('foob');
    expect(new TextDecoder().decode(base64Decode('Zm9vYg')!)).toBe('foob');
    expect(base64Decode('Zm9v*g==')).toBeNull();
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64Decode(base64Encode(all))).toEqual(all);
  });
});

describe('CRC16 and errorInfo frames (ported SyaiNotifyInfoTests)', () => {
  it('CRC16/Modbus known answer', () => {
    expect(crc16Modbus(new TextEncoder().encode('123456789'))).toBe(0x4b37);
  });

  it('disconnect ring decodes a real frame', () => {
    const f = decodeNotifyInfo(fromHex('0477973d130013100000b53d130013100000d43d1300131000002f3e130013100000a33e130016100000'))!;
    expect(f.header).toBe(0x7704);
    if (f.content.kind !== 'disconnectLog') throw new Error('expected disconnectLog');
    expect(f.content.events.map((e) => e.tick)).toEqual([1_260_951, 1_260_981, 1_261_012, 1_261_103, 1_261_219]);
    expect(f.content.events.map((e) => e.reason)).toEqual([0x1013, 0x1013, 0x1013, 0x1013, 0x1016]);
    expect(f.content.events[0]!.lastStatus).toBeNull();
  });

  it('names only the three correlated reason codes', () => {
    expect([0x1008, 0x1013, 0x1016, 0x1040].map(reasonName)).toEqual(['orderly', 'abnormal/early', 'central-side', '0x1040']);
  });

  it('reboot ring has 12-byte records', () => {
    const f = decodeNotifyInfo(fromHex('05770000000003000000030000000000000003000000000000000200000040100000' + '01000000000000000300000003000000000000000400000003000000'))!;
    if (f.content.kind !== 'rebootLog') throw new Error('expected rebootLog');
    expect(f.content.events).toHaveLength(5);
    expect(f.content.events[2]!.reason).toBe(0x1040);
    expect(f.content.events.map((e) => e.lastStatus)).toEqual([3, 0, 1, 3, 3]);
  });

  it('interval info long and short forms', () => {
    expect(decodeNotifyInfo(fromHex('0777860104007017'))!.content).toEqual({ kind: 'intervalInfo', interval: 390, delay: 4, timeout: 6000 });
    expect(decodeNotifyInfo(fromHex('07778601'))!.content).toEqual({ kind: 'intervalInfo', interval: 390, delay: null, timeout: null });
  });

  it('coefficient echo carries a CRC over the original write frame', () => {
    const f = decodeNotifyInfo(fromHex('08773dcccccd3f0000004194000000000000bab780343f056d5dbe856d5d3c75c28f' + '3f7333333f4ccccd3f8ccccd3d4ccccd4828c0003f80000027e4'))!;
    if (f.content.kind !== 'coefficients') throw new Error('expected coefficients');
    expect(f.content.values).toHaveLength(14);
    expect(f.content.crc).toBe(0xe427);
    expect(f.content.crcOK).toBe(true);
    expect(f.content.values[2]).toBeCloseTo(18.5, 5);
    expect(f.content.values[12]).toBeCloseTo(172_800, 0);
  });

  it('trivial, unknown and malformed headers keep their bytes', () => {
    expect(decodeNotifyInfo(fromHex('06772a000000'))!.content).toEqual({ kind: 'value', value: 42 });
    expect(decodeNotifyInfo(fromHex('09774f4b'))!.content).toEqual({ kind: 'stateText', text: 'OK' });
    expect(decodeNotifyInfo(fromHex('0a77deadbeef'))!.content).toEqual({ kind: 'rawHex', hex: 'deadbeef' });
    const bad = decodeNotifyInfo(fromHex('04779153'))!;
    expect(bad.content).toEqual({ kind: 'malformed', header: 0x7704, hex: '9153' });
    expect(bad.orgHex).toBe('04779153');
    expect(decodeNotifyInfo(new Uint8Array([4]))).toBeNull();
  });
});

describe('frame cipher and record windows (ported SyaiTransportTests)', () => {
  it('record length and parse-version dispatch', () => {
    expect(recordLength('V1.7')).toBe(9);
    expect(recordLength('V1.5')).toBe(8);
    expect(parseVersionForDevice('E2.0.1(V1.7.SH22537.1)')).toBe('V1.7');
    expect(parseVersionForDevice('x V1.6 y')).toBe('V1.6');
    expect(parseVersionForDevice('unknown')).toBe('V1.5');
    expect(parseVersionForDevice('E2.1.0(V1.8.SH30101.1)')).toBe('V1.7');
    expect(parseVersionForDevice('E3.0.0(V2.0.SH30101.1)')).toBe('V1.7');
  });

  it('only V1.6 and V1.7 are verified; newer firmware has no profile', () => {
    expect(isVerifiedParseVersion('V1.7')).toBe(true);
    expect(isVerifiedParseVersion('V1.6')).toBe(true);
    expect(isVerifiedParseVersion('V1.5')).toBe(false);
    for (const v of ['E2.2.0(V1.9.SH30101.1)', 'E3.1.0(V2.1.SH30101.1)', 'E4.0.0(V3.0.SH30101.1)']) {
      expect(isVerifiedParseVersion(parseVersionForDevice(v))).toBe(false);
    }
    expect(() => rawChannels(new Uint8Array(13), 'V1.5')).toThrow(/not hardware-verified/);
    expect(() => rawChannels(new Uint8Array(10), 'V1.7')).toThrow(/too short/);
  });

  it('splits records, skipping zero padding, with framed index', () => {
    const org = new Uint8Array([0, 0, 0, 0, 5, 0, 0, 0, ...Array.from({ length: 18 }, (_, i) => i), ...new Uint8Array(9)]);
    const records = splitRecords(org, 9);
    expect(records.map((r) => r.index)).toEqual([5, 6]);
    expect(records[0]!.framed).toHaveLength(13);
    expect([...records[0]!.framed.slice(0, 4)]).toEqual([0, 0, 5, 0]);
    expect([...records[0]!.framed.slice(4)]).toEqual(Array.from({ length: 9 }, (_, i) => i));
  });

  it('decrypts AES-ECB frames, tolerating trailing partial blocks', () => {
    const key = Uint8Array.from({ length: 16 }, (_, i) => i);
    const plain = new Uint8Array(32).fill(0x5a);
    const ct = ecb(key, { disablePadding: true }).encrypt(plain);
    expect(decryptOrg(ct, key)).toEqual(plain);
    expect(decryptOrg(new Uint8Array([...ct, 1, 2, 3]), key)).toEqual(plain);
    expect(() => decryptOrg(new Uint8Array(5), key)).toThrow(/no whole AES block/);
    expect(() => decryptOrg(new Uint8Array(0), key)).toThrow(/empty/);
  });

  it('reads the paging header', () => {
    const live = packetInfo(new Uint8Array([0, 0, 0, 0, 0x10, 0, 0xff, 0xff]));
    expect([live.startIndex, live.surplusPackage, live.isBatchComplete]).toEqual([16, -1, true]);
    expect(packetInfo(new Uint8Array([0, 0, 0, 0, 1, 0, 2, 0])).isBatchComplete).toBe(false);
    expect(() => packetInfo(new Uint8Array(4))).toThrow(/header/);
  });

  it('advertised MAC drops the company id', () => {
    expect(advertisedMac(new Uint8Array([0xab, 0xcd, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55]))).toBe('001122334455');
    expect(advertisedMac(new Uint8Array([1]))).toBeNull();
    expect(advertisedMac(null)).toBeNull();
  });
});

describe('BLE auth primitives (ported SyaiTransportTests)', () => {
  it('session key is the odd bytes of the shared secret X', () => {
    const key = sessionKeyFromSharedSecretX(Uint8Array.from({ length: 32 }, (_, i) => i));
    expect([...key]).toEqual(Array.from({ length: 16 }, (_, i) => i * 2 + 1));
  });

  it('key group slicing wraps modulo 6 and rejects a wrong length', () => {
    const raw = Uint8Array.from({ length: 96 }, (_, i) => i);
    expect([...keyAt(2, raw)]).toEqual(Array.from({ length: 16 }, (_, j) => 32 + j));
    expect(keyAt(8, raw)).toEqual(keyAt(2, raw));
    expect(() => keyAt(0, new Uint8Array(32))).toThrow(/expected 96/);
  });

  it('mac bytes and signature preimage order', () => {
    expect([...macBytes('001122334455')]).toEqual([0, 0x11, 0x22, 0x33, 0x44, 0x55]);
    expect(appSignature(new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), new Uint8Array([4]), new Uint8Array([5]))).toEqual(sha256(new Uint8Array([1, 2, 3, 4, 5])));
  });

  it('currentTime enters the digest as 00 | wire[0] | wire[1]', () => {
    expect([...currentTimeDigestEncoding(new Uint8Array([0x34, 0x12, 0x00, 0x00]))]).toEqual([0x00, 0x34, 0x12]);
    expect([...currentTimeDigestEncoding(new Uint8Array([7, 8, 9]))]).toEqual([7, 8, 9]);
  });

  it('blob layouts', () => {
    const x = new Uint8Array(32).fill(0xaa);
    const y = new Uint8Array(32).fill(0xbb);
    const blob = appParamBlob(0x1234, 3, x, y);
    expect(blob).toHaveLength(68);
    expect([...blob.slice(0, 4)]).toEqual([3, 0, 0x34, 0x12]);
    const dev = parseDeviceParams(new Uint8Array([8, 1, 2, 3, ...x, ...y]));
    expect(dev.idx).toBe(2); // 8 % 6
    expect([...dev.time]).toEqual([1, 2, 3]);
    expect(() => parseDeviceParams(new Uint8Array(10))).toThrow(/too short/);
  });

  it('verifies the device signature and rejects a peer without the key group', () => {
    const keyGroup = Uint8Array.from({ length: 96 }, (_, i) => (i * 7) & 0xff);
    const mac = macBytes('AABBCCDDEEFF');
    const params = { idx: 1, time: new Uint8Array([1, 2, 3]), pubX: new Uint8Array(32).fill(1), pubY: new Uint8Array(32).fill(2) };
    const sign = sha256(new Uint8Array([...keyAt(1, keyGroup), ...mac, ...params.pubX, ...params.pubY, ...params.time]));
    expect(() => verifyDeviceSignature(sign, params, mac, keyGroup)).not.toThrow();
    expect(() => verifyDeviceSignature(new Uint8Array(32), params, mac, keyGroup)).toThrow(/does not hold the key group/);
  });
});

describe('real captures decode to the recorded glucose (ported SyaiGroundTruthDBTests)', () => {
  const check = (vectors: readonly Vec[], parseVersion: string, coefficients: readonly number[]) => {
    for (const [h, elapsed, current, mmol] of vectors) {
      const raw = rawChannels(fromHex(h), parseVersion);
      expect(raw.v0).toBe(current);
      expect(raw.v2).toBe(elapsed);
      const out = decodeGlucose(raw, coefficients);
      // The original test tolerates 0.051 mmol/L (the sensor's 0.1 step) of the app's own rounding.
      expect(Math.abs(out.rawGlucoseMgDL - mmol * 18)).toBeLessThanOrEqual(0.051 * 18);
    }
  };

  it('V1.6, across the whole sensor life including past the 48 h / C12 boundary', () => {
    expect(V16_VECTORS.some(([, e]) => e > 172_800)).toBe(true);
    check(V16_VECTORS, 'V1.6', V16_COEFFICIENTS);
  });

  it('V1.7', () => check(V17_VECTORS, 'V1.7', V17_COEFFICIENTS));
});

describe('RPN evaluator and glucose decoder (ported SyaiGlucoseDecoderTests)', () => {
  it('basic ops, registers and last statement wins', () => {
    expect(evaluateProgram('2 3 ad;5 R0 ml', {})).toBe(25);
    expect(evaluateStatement('12.345 1 rd', {})).toBeCloseTo(12.3, 9);
    expect(evaluateStatement('-2.5 0 rd', {})).toBe(-3); // half away from zero, like Swift
  });

  it('comparators are ternary: (a op b) ? c : 0', () => {
    expect(evaluateStatement('1 2 99 le', {})).toBe(99);
    expect(evaluateStatement('3 2 99 le', {})).toBe(0);
    expect(evaluateStatement('3 2 99 gt', {})).toBe(99);
    expect(evaluateStatement('1 2 99 gt', {})).toBe(0);
    expect(() => evaluateStatement('1 2 le', {})).toThrow(/stack underflow/);
  });

  it('unset registers and unknown tokens are errors, never silent zeros', () => {
    expect(() => evaluateStatement('R9 1 ad', {})).toThrow(/unset register/);
    expect(() => evaluateStatement('zz', {})).toThrow(/unknown token/);
    expect(() => evaluateStatement('', {})).toThrow(/empty/);
  });

  it('statement 5 pins to C13 past 48 h instead of drifting', () => {
    const c = V16_COEFFICIENTS;
    const s5 = 'C10 V2 86400 dv C11 ml sb V2 C12 1 le ml V2 C12 1 gt C13 ml ad';
    const r4 = (v2: number) => evaluateStatement(s5, { ...Object.fromEntries(c.map((x, i) => [`C${i}`, x])), V0: 0, V1: 0, V2: v2 });
    expect(r4(172_799)).toBeCloseTo(1.0, 6);
    expect(r4(172_801)).toBeCloseTo(1.0, 9);
    expect(r4(14 * 24 * 3600)).toBeCloseTo(1.0, 9);
  });

  it('embeds the molar-mass factor verbatim', () => {
    expect(GLUCOSE_PROGRAM).toContain(`${MMOL_TO_MGDL} ml 0 rd`);
  });

  it('decodes with the default coefficients and clamps below range', () => {
    const out = decodeGlucose({ v0: 1000, v1: 1200, v2: 43200 }, DEFAULT_COEFFICIENTS);
    expect(out.rawGlucoseMgDL).toBeCloseTo(18, 9);
    expect(out.condition).toBe('belowRange');
    expect(out.adjustedGlucoseMgDL).toBe(36);
  });

  const constant = (product: number) => Object.assign(new Array<number>(14).fill(0), { 9: product, 10: 1, 12: 172_800 });
  it('clamps LO / HI and passes in-range values through', () => {
    const raw = { v0: 1000, v1: 1200, v2: 43200 };
    expect(decodeGlucose(raw, constant(100))).toMatchObject({ condition: 'aboveRange', adjustedGlucoseMgDL: 450 });
    expect(decodeGlucose(raw, constant(6.5))).toMatchObject({ condition: null, adjustedGlucoseMgDL: 117 });
    expect(decodeGlucose(raw, constant(6.1)).adjustedGlucoseMgDL).toBe(110); // whole mg/dL, never 109.8
  });

  it('throws on non-finite results and wrong coefficient counts', () => {
    expect(() => decodeGlucose({ v0: NaN, v1: 1200, v2: 43200 }, DEFAULT_COEFFICIENTS)).toThrow(DecodeError);
    expect(() => decodeGlucose({ v0: 1, v1: 1, v2: 1 }, new Array<number>(13).fill(0))).toThrow(/13 coefficients/);
  });
});

describe('account provisioning (ported SyaiCoefficientDecipherTests / key group tests)', () => {
  const csv = '0.1,0.5,18.5,0.0000,-0.0014,0.5212,-0.2606,0.015,0.95,0.8,1.1,0.05,172800,1';
  const wrap = (plain: Uint8Array | string, key: string) => base64Encode(ecb(new TextEncoder().encode(key)).encrypt(typeof plain === 'string' ? new TextEncoder().encode(plain) : plain));

  it('derives the 32-byte wrap key', () => {
    const key = deriveWrapKey('SECRETKEY0000000', 1_770_346_120_828, '001122334455');
    expect(key).toBe('SECRETKEY00000000346120828334455');
    expect(key).toHaveLength(32);
  });

  it('parses and validates coefficient CSV', () => {
    expect(parseCoefficients(csv)).toEqual(V17_COEFFICIENTS);
    expect(() => parseCoefficients('1,2,3')).toThrow(/expected 14/);
    expect(() => parseCoefficients('0.1,0.5,18.5,x,-0.0014,0.5212,-0.2606,0.015,0.95,0.8,1.1,0.05,172800,1')).toThrow(/non-numeric/);
  });

  it('full decipher round trip', () => {
    const key = deriveWrapKey('SECRETKEY0000000', 1_770_346_120_828, '001122334455');
    expect(decipherCoefficients(wrap(csv, key), 1_770_346_120_828, '001122334455', 'SECRETKEY0000000')).toEqual(V17_COEFFICIENTS);
  });

  it('key group: 96 raw bytes and 192 hex characters unwrap; anything else is refused', () => {
    const ninetySix = Uint8Array.from({ length: 96 }, (_, i) => i);
    const key = deriveWrapKey('SECRETKEY0000000', 1_700_000_000_000, '001122334455');
    const unwrap = (p: Uint8Array | string) => decipherKeyGroup(wrap(p, key), 1_700_000_000_000, '001122334455', 'SECRETKEY0000000');
    expect(unwrap(ninetySix)).toEqual(ninetySix);
    expect(unwrap(hex(ninetySix).toUpperCase())).toEqual(ninetySix);
    expect(() => unwrap('!'.repeat(192))).toThrow(/expected 96 raw or 192 hex/);
    expect(() => unwrap(new Uint8Array(80))).toThrow(/expected 96 raw or 192 hex/);
  });

  it('applicator QR payload is only ever a MAC (ported SyaiApplicatorCodeTests)', () => {
    expect(macFromApplicatorCode('AABBCCDDEEFF')).toBe('AABBCCDDEEFF');
    expect(macFromApplicatorCode('aabbccddeeff\n')).toBe('AABBCCDDEEFF');
    expect(macFromApplicatorCode('AA:BB:CC:DD:EE:FF')).toBe('AABBCCDDEEFF');
    expect(macFromApplicatorCode('AA-BB-CC-DD-EE-FF')).toBe('AABBCCDDEEFF');
    for (const bad of ['', 'AABBCCDDEE', 'AABBCCDDEEFF00', 'AABBCCDDEEFG', 'https://example.com/AABBCCDDEEFF']) expect(macFromApplicatorCode(bad)).toBeNull();
  });
});

describe('forward grid and backfill range (ported SyaiBackfillGridTests)', () => {
  it('keeps exactly every 5th record', () => {
    for (const s of [0, 5, 10, 45, 100, 500, 65535]) expect(isOnForwardGrid(s)).toBe(true);
    for (const s of [1, 2, 3, 4, 6, 99, 101, 499, 65534]) expect(isOnForwardGrid(s)).toBe(false);
    const kept = Array.from({ length: 1000 }, (_, i) => i).filter(isOnForwardGrid);
    expect(kept).toHaveLength(200);
  });

  const range = (have: number, newest: number, first = 30, max = 400) => backfillRange(have, newest, first, max);

  it('requests nothing for a contiguous stream or when already holding the newest', () => {
    expect(range(2904, 2905)).toBeNull();
    expect(range(2905, 2905)).toBeNull();
    expect(range(2910, 2905)).toBeNull();
  });

  it('a hole with no grid record is not requested', () => {
    expect(range(3063, 3065)).toBeNull();
    expect(range(3061, 3065)).toBeNull();
  });

  it('both ends snap to the grid and the live frame is excluded', () => {
    expect(range(3060, 3075)).toEqual({ start: 3065, count: 6, remaining: null });
    expect(range(2910, 2915)).toBeNull();
    expect(range(2905, 2915)).toEqual({ start: 2910, count: 1, remaining: null });
  });

  it('warmup-era records are clamped out', () => {
    expect(range(5, 61, 30)).toEqual({ start: 30, count: 31, remaining: null });
    expect(range(2, 20, 30)).toBeNull();
    expect(firstBackfillableSequence(30 * 60)).toBe(30);
  });

  it('wide gaps are chunked on grid indices and resume without skipping', () => {
    expect(range(100, 1001, 30, 400)).toEqual({ start: 105, count: 396, remaining: 500 });
    expect(range(500, 1001, 30, 400)).toEqual({ start: 505, count: 396, remaining: 900 });
    expect(range(900, 1001, 30, 400)).toEqual({ start: 905, count: 96, remaining: null });
  });

  it('saturated sequences do not misbehave', () => {
    expect(range(65535, 65535)).toBeNull();
    expect(range(65535, 0)).toBeNull();
    expect(range(65530, 65535)).toBeNull();
    expect(range(65520, 65535)).toEqual({ start: 65525, count: 6, remaining: null });
  });

  it('a request fits one 176-byte notify packet; unknown versions never get the larger chunk', () => {
    expect(maxBackfillRequestCount('V1.7')).toBe(18);
    expect(maxBackfillRequestCount('V1.6')).toBe(20);
    expect(fitsOnePacket('V1.7')).toBe(true);
    expect(fitsOnePacket('V1.6')).toBe(true);
    expect(maxBackfillRequestCount('V1.5') * 9).toBeLessThanOrEqual(176 - 8);
  });
});

describe('plausibility guard (ported SyaiPlausibilityGuardTests)', () => {
  const feed = (g: PlausibilityGuard, count: number, current: number, mmol: number, start = 1) => {
    let last = null as ReturnType<PlausibilityGuard['record']>;
    for (let i = 0; i < count; i++) last = g.record(start + i, current, mmol) ?? last;
    return last;
  };

  it('low current fires attention on the 5th sample and broken on the 35th', () => {
    const g = new PlausibilityGuard();
    // 2.5 mmol/L sits above the glucoseLow1 floor, so only the low-current detector is in play.
    expect(feed(g, ATTENTION_COUNT0 - 1, 47, 2.5)).toBeNull();
    expect(g.attentionActive).toBe(false);
    expect(g.record(5, 47, 2.5)).toEqual({ reason: 'lowCurrent', level: 'attention' });
    expect(g.attentionActive).toBe(true);
    expect(feed(g, 29, 47, 2.5, 6)).toBeNull();
    expect(g.record(35, 47, 2.5)).toEqual({ reason: 'lowCurrent', level: 'broken' });
  });

  it('a threshold value is not an error, one good sample resets the streak and recovery clears attention', () => {
    const exact = new PlausibilityGuard();
    expect(feed(exact, 40, 2000, 5.0)).toBeNull();
    const reset = new PlausibilityGuard();
    feed(reset, 4, 47, 5.0);
    reset.record(5, 10000, 5.0);
    feed(reset, 4, 47, 5.0, 6);
    expect(reset.attentionActive).toBe(false);
    const recover = new PlausibilityGuard();
    feed(recover, 5, 47, 2.5);
    expect(recover.attentionActive).toBe(true);
    recover.record(6, 12000, 5.0);
    expect(recover.attentionActive).toBe(false);
  });

  it('glucose detectors: short streak at 40 / 1.0, long streak at 35 / 2.1, broken at 250', () => {
    expect(feed(new PlausibilityGuard(), 5, 10000, 41)).toEqual({ reason: 'glucoseHigh0', level: 'attention' });
    expect(feed(new PlausibilityGuard(), 5, 10000, 0.9)).toEqual({ reason: 'glucoseLow0', level: 'attention' });
    const g = new PlausibilityGuard();
    expect(feed(g, 9, 10000, 36)).toBeNull(); // above 35 but not above 40
    expect(g.record(10, 10000, 36)).toEqual({ reason: 'glucoseHigh1', level: 'attention' });
    feed(g, 239, 10000, 36, 11);
    expect(g.record(250, 10000, 36)).toEqual({ reason: 'glucoseHigh1', level: 'broken' });
    for (const mmol of [40, 1.0]) expect(feed(new PlausibilityGuard(), 9, 10000, mmol)).toBeNull();
  });

  it('exact redelivery is ignored, but backfill behind a newer live sample is still evaluated', () => {
    const g = new PlausibilityGuard();
    feed(g, 3, 10000, 5.0);
    expect(g.record(1, 47, 0.5)).toBeNull();
    expect(g.attentionActive).toBe(false);
    const behind = new PlausibilityGuard();
    expect(behind.record(1000, 10000, 5.0)).toBeNull();
    expect(feed(behind, 5, 47, 5.0)).toEqual({ reason: 'lowCurrent', level: 'attention' });
  });

  it('shake points: 30 zigzag extrema break the sensor', () => {
    const g = new PlausibilityGuard();
    let event = null as ReturnType<PlausibilityGuard['record']>;
    for (let i = 1; i <= 40; i++) event = g.record(i, 10000, i % 2 ? 5 : 9) ?? event;
    expect(event).toEqual({ reason: 'shake', level: 'broken' });
  });
});

describe('sensor lifecycle (ported SyaiSensorLifecycleTests)', () => {
  const now = 1_700_000_000_000;
  const wear = 14 * 86400;
  const warm = 30 * 60;
  const base = { sensorPaired: true, latestReadingAt: now, hasLiveLink: true, activeDurationSec: wear, preheatDurationSec: warm, now };
  const agoSec = (s: number) => now - s * 1000;

  it('phases from timestamps', () => {
    expect(computeLifecycle({ ...base, activatedAt: agoSec(10 * 60), preheatDurationSec: 5 * 60 }).phase).toBe('active');
    const w = computeLifecycle({ ...base, activatedAt: agoSec(3 * 60), preheatDurationSec: 5 * 60, latestReadingAt: null });
    expect(w).toMatchObject({ phase: 'warmup' });
    if (w.phase === 'warmup') expect(w.progress).toBeCloseTo(0.6, 6);
    expect(computeLifecycle({ ...base, activatedAt: agoSec(wear + 1) }).phase).toBe('expired');
    expect(computeLifecycle({ ...base, sensorPaired: false, activatedAt: null }).phase).toBe('noSensor');
  });

  it('missing durations mean unknown, never a default', () => {
    expect(computeLifecycle({ ...base, activatedAt: agoSec(600), preheatDurationSec: null }).phase).toBe('noSensor');
    expect(computeLifecycle({ ...base, activatedAt: agoSec(600), activeDurationSec: null }).phase).toBe('noSensor');
  });

  it('faults override timestamps; an obsolete state past wear is just expiry', () => {
    const active = { ...base, activatedAt: agoSec(2 * 86400) };
    expect(computeLifecycle({ ...active, fault: { kind: 'deviceStateObsolete', state: 4 } }).phase).toBe('failed');
    expect(computeLifecycle({ ...active, fault: { kind: 'deviceStateUnactivated', state: 2 } }).phase).toBe('unactivated');
    expect(computeLifecycle({ ...active, fault: { kind: 'signalImplausible' } }).phase).toBe('failed');
    expect(computeLifecycle({ ...base, activatedAt: agoSec(wear + 3600), fault: { kind: 'deviceStateObsolete', state: 4 } }).phase).toBe('expired');
    expect(computeLifecycle({ ...base, activatedAt: null, fault: { kind: 'deviceStateObsolete', state: 4 } }).phase).toBe('failed');
  });

  it('sensor elapsed field beats the phone clock, and silence reads as signal loss', () => {
    const stale = computeLifecycle({ ...base, activatedAt: agoSec(86400), latestReadingAt: agoSec(7 * 60) });
    expect(stale.phase).toBe('signalLost');
    const viaSensor = computeLifecycle({ ...base, activatedAt: agoSec(60), sensorAge: { elapsedSec: wear + 10, at: now } });
    expect(viaSensor.phase).toBe('expired');
  });
});
