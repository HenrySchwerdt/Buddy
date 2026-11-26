/**
 * Port of `Bluetooth/Session/Milenage.swift` and `EapSqn.swift` from OmnipodKit (MIT License,
 * (c) LoopKit Authors): the 3GPP MILENAGE functions (f1..f5*) with the pod's fixed OP/AMF, used
 * by the EAP-AKA session establishment.
 */
import type { Bytes } from '@buddy/core';
import { concatBytes, fromHex } from '@buddy/core';
import { randomBytes, xorBytes } from '../common/bytes';
import { aesEcbEncrypt } from './crypto';
import { OmnipodError } from './errors';

export const MILENAGE_OP = fromHex('cdc202d5123e20f62b6d676ac72cb318');
export const MILENAGE_AMF = fromHex('b9b9');
export const RESYNC_AMF = fromHex('0000');
export const KEY_SIZE = 16;
export const AUTS_SIZE = 14;
export const SQN_SIZE = 6;

export interface Milenage {
  readonly rand: Bytes;
  readonly sqn: Bytes;
  readonly autn: Bytes;
  readonly res: Bytes;
  readonly ck: Bytes;
  readonly ak: Bytes;
  readonly akStar: Bytes;
  readonly macS: Bytes;
  /** SQN recovered from the AUTS the pod sent when it asked for a resynchronisation */
  readonly synchronizationSqn: Bytes;
  readonly receivedMacS: Bytes;
}

export interface MilenageInput {
  readonly k: Bytes;
  readonly sqn: Bytes;
  readonly rand?: Bytes;
  readonly auts?: Bytes;
  readonly amf?: Bytes;
}

export function milenage(input: MilenageInput): Milenage {
  const { k, sqn } = input;
  const auts = input.auts ?? new Uint8Array(AUTS_SIZE);
  const amf = input.amf ?? MILENAGE_AMF;
  if (k.length !== KEY_SIZE) throw new OmnipodError('session', `Milenage key has to be ${KEY_SIZE} bytes long`);
  if (sqn.length !== SQN_SIZE) throw new OmnipodError('session', `Milenage SQN has to be ${SQN_SIZE} bytes long`);
  if (auts.length !== AUTS_SIZE) throw new OmnipodError('session', `Milenage AUTS has to be ${AUTS_SIZE} bytes long`);
  if (amf.length !== MILENAGE_AMF.length) throw new OmnipodError('session', 'Milenage AMF has to be 2 bytes long');

  const E = (b: Bytes): Bytes => aesEcbEncrypt(k, b);
  const rand = input.rand ?? randomBytes(KEY_SIZE);
  if (rand.length !== KEY_SIZE) throw new OmnipodError('session', 'Milenage RAND has to be 16 bytes long');
  const opc = xorBytes(E(MILENAGE_OP), MILENAGE_OP);
  const randOpcEncrypted = E(xorBytes(rand, opc));
  const x = xorBytes(randOpcEncrypted, opc);
  const rotated = (rot: number): Uint8Array => {
    const out = new Uint8Array(KEY_SIZE);
    for (let i = 0; i < KEY_SIZE; i++) out[(i + rot) % KEY_SIZE] = x[i]!;
    return out;
  };

  const resAkInput = x.slice();
  resAkInput[15] = resAkInput[15]! ^ 1;
  const resAk = xorBytes(E(resAkInput), opc);

  const ckInput = rotated(12);
  ckInput[15] = ckInput[15]! ^ 2;
  const ck = xorBytes(E(ckInput), opc);

  const sqnAmf = concatBytes(sqn, amf, sqn, amf);
  const sqnAmfXorOpc = xorBytes(sqnAmf, opc);
  const macAInput = new Uint8Array(KEY_SIZE);
  for (let i = 0; i < KEY_SIZE; i++) macAInput[(i + 8) % KEY_SIZE] = sqnAmfXorOpc[i]!;
  const macAFull = xorBytes(E(xorBytes(macAInput, randOpcEncrypted)), opc);
  const ak = resAk.slice(0, 6);

  const akStarInput = rotated(4);
  akStarInput[15] = akStarInput[15]! ^ 8;
  const akStar = xorBytes(E(akStarInput), opc).slice(0, 6);

  return {
    rand,
    sqn,
    autn: concatBytes(xorBytes(ak, sqn), amf, macAFull.slice(0, 8)),
    res: resAk.slice(8, 16),
    ck,
    ak,
    akStar,
    macS: macAFull.slice(8, 16),
    synchronizationSqn: xorBytes(akStar, auts.slice(0, 6)),
    receivedMacS: auts.slice(6, 14),
  };
}

/** 6 byte big-endian EAP sequence number for the MILENAGE SQN. */
export function eapSqnBytes(n: number): Bytes {
  if (!Number.isSafeInteger(n) || n < 0) throw new OmnipodError('session', 'Invalid EAP sequence number');
  const out = new Uint8Array(SQN_SIZE);
  for (let i = SQN_SIZE - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff;
  return out;
}

export function eapSqnToInt(b: Bytes): number {
  if (b.length !== SQN_SIZE) throw new OmnipodError('session', 'Invalid EAP sequence number size');
  return b.reduce((acc, v) => acc * 256 + v, 0);
}
