/**
 * TypeScript port of the byte/time helpers MedtrumKit uses (`Common/Data.swift`, `Common/Int64.swift`,
 * `Common/Date.swift`) from loopandlearn/MedtrumKit (MIT License, (c) the original MedtrumKit authors).
 */
import type { Bytes, Millis } from '@buddy/core';

/** 2014-01-01T00:00:00Z — Medtrum timestamps are seconds since this epoch. */
export const MEDTRUM_BASE_UNIX_SECONDS = 1_388_534_400;

/** Insulin resolution of the Nano (bolus, basal, reservoir): 0.05 U. */
export const MEDTRUM_INSULIN_STEP = 0.05;

/** Little-endian unsigned integer of `length` (1..6) bytes at `offset`. Throws if out of range. */
export function leUint(data: Bytes, offset: number, length: number): number {
  if (length < 0 || length > 6) throw new Error(`leUint: unsupported length ${length}`);
  if (offset < 0 || offset + length > data.length) {
    throw new RangeError(`Medtrum: read of ${length} bytes at ${offset} exceeds payload of ${data.length}`);
  }
  let result = 0;
  for (let i = 0; i < length; i++) result += data[offset + i]! * 2 ** (8 * i);
  return result;
}

/** One byte at `index`; throws (instead of returning undefined) when the payload is too short. */
export function byteAt(data: Bytes, index: number): number {
  const v = data[index];
  if (v === undefined) throw new RangeError(`Medtrum: byte ${index} missing from payload of ${data.length}`);
  return v;
}

/** Little-endian encoding of a non-negative integer into `length` bytes (UInt64.toData(length:)). */
export function toLeBytes(value: number, length: number): Bytes {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`toLeBytes: ${value} is not a non-negative integer`);
  const out = new Uint8Array(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

export const fromMedtrumSeconds = (seconds: number): Millis => (MEDTRUM_BASE_UNIX_SECONDS + seconds) * 1000;

/** `Date.toMedtrumSeconds()`: 4 bytes LE, whole seconds since 2014-01-01 (truncated). */
export function toMedtrumSeconds(date: Millis): Bytes {
  const seconds = Math.trunc(date / 1000 - MEDTRUM_BASE_UNIX_SECONDS);
  if (seconds < 0 || seconds > 0xffff_ffff) throw new RangeError(`Medtrum: date ${date} outside the patch clock range`);
  return toLeBytes(seconds, 4);
}

/**
 * Converts an insulin amount (U or U/h) to pump steps of 0.05.
 *
 * DEVIATION from MedtrumKit: Swift uses `round(x / 0.05)`, which can round a dose *up* by up to
 * 0.025 U. Buddy never rounds insulin up, so this floors. The 1e-6 step tolerance (5e-8 U) only
 * absorbs binary floating point error (1.4 / 0.05 = 27.999999999999996).
 */
export function insulinToSteps(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`Medtrum: invalid insulin amount ${amount}`);
  return Math.floor(amount / MEDTRUM_INSULIN_STEP + 1e-6);
}

/** Steps back to units, rounded to 2 decimals to strip floating point noise (exact for 0.05 multiples). */
export const stepsToInsulin = (steps: number): number => Math.round(steps * MEDTRUM_INSULIN_STEP * 100) / 100;

/** Largest multiple of 0.05 that is <= amount. */
export const floorToInsulinStep = (amount: number): number => stepsToInsulin(insulinToSteps(amount));
