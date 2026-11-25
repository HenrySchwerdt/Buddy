/**
 * TypeScript port of `MedtrumKit/Encryption/Crypto.swift` from loopandlearn/MedtrumKit
 * (MIT License, (c) the original MedtrumKit authors).
 *
 * The Medtrum "authorization key" is derived from the pump base serial number only: two rounds
 * of a Park-Miller style PRNG followed by 32 rounds of rotate + Rijndael S-box substitution.
 * The Swift original does this in Int64 and only ever looks at the low 32 bits of each round,
 * so this port works on unsigned 32-bit values (`>>> 0`) throughout.
 */
import type { Bytes } from '@buddy/core';
import { RIJNDEAL_INVERSE_S_BOX, RIJNDEAL_S_BOX } from './crypto-tables';
import { leUint, toLeBytes } from './bytes';

const MEDTRUM_CIPHER = 1_344_751_489;

/**
 * Generates the 4-byte auth key from the pump serial number.
 * `pumpSN` is the serial as the AuthorizePacket passes it: little-endian (already reversed).
 */
export function genKey(pumpSN: Bytes): Bytes {
  const sn = leUint(pumpSN, 0, pumpSN.length);
  const key = randomGen(randomGen((MEDTRUM_CIPHER ^ sn) >>> 0));
  return toLeBytes(simpleCrypt(key), 4);
}

/** 4 random bytes from the platform CSPRNG. Throws if none is available (never falls back to Math.random). */
export function genSessionToken(): Bytes {
  const c = (globalThis as { crypto?: { getRandomValues?: <T extends Uint8Array>(a: T) => T } }).crypto;
  if (!c?.getRandomValues) throw new Error('Medtrum: no secure random source (crypto.getRandomValues) available');
  return c.getRandomValues(new Uint8Array(4));
}

/** Inverse of the key derivation's final stage; used to recover the model number from the serial. */
export function simpleDecrypt(input: Bytes): Bytes {
  let temp = leUint(input, 0, input.length);
  for (let i = 0; i < 32; i++) {
    const x = changeByTable(temp, RIJNDEAL_INVERSE_S_BOX);
    temp = rotateRight32(x);
  }
  return toLeBytes((temp ^ MEDTRUM_CIPHER) >>> 0, 4);
}

function randomGen(input: number): number {
  const a = 16807;
  const q = 127_773;
  const r = 2836;

  // Int64 division in Swift truncates toward zero; all values here stay far below 2^53.
  const tmp1 = Math.trunc(input / q);
  let ret = (input - tmp1 * q) * a - tmp1 * r;
  if (ret < 0) {
    ret += 2_147_483_647;
  }
  return ret;
}

function simpleCrypt(input: number): number {
  let temp = (input ^ MEDTRUM_CIPHER) >>> 0;
  for (let i = 0; i < 32; i++) {
    temp = changeByTable(rotateLeft32(temp), RIJNDEAL_S_BOX);
  }
  return temp;
}

const rotateLeft32 = (x: number): number => ((x << 1) | (x >>> 31)) >>> 0;
const rotateRight32 = (x: number): number => ((x >>> 1) | (x << 31)) >>> 0;

function changeByTable(input: number, table: readonly number[]): number {
  const value = toLeBytes(input >>> 0, 4);
  const result = value.map((b) => table[b]!);
  return leUint(result, 0, 4);
}
