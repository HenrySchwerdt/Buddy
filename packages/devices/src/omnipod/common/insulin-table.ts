/**
 * Insulin delivery tables. Port of `OmnipodCommon/InsulinTableEntry.swift`,
 * `BasalDeliveryTable.swift` (including `RateEntry`) and the immediate-bolus part of
 * `BolusDeliveryTable.swift` from OmnipodKit (MIT License, (c) LoopKit Authors).
 *
 * DELIBERATELY NOT PORTED: extended / combo boluses. Buddy never programs them, and the
 * immediate bolus table is a single entry.
 */
import { be16, be32, u16be, u32be } from './bytes';
import { HOUR, MINUTE, POD } from './pod-constants';
import type { Bytes } from '@buddy/core';

export const MAX_TIME_BETWEEN_PULSES = 5 * HOUR;
export const NEAR_ZERO_BASAL_RATE_FLAG = 0x80000000;
export const SEGMENT_DURATION = 30 * MINUTE;
const MAX_SEGMENTS_PER_ENTRY = 16;

// ── InsulinTableEntry ───────────────────────────────────────────────────────

export interface InsulinTableEntry {
  readonly segments: number;
  readonly pulses: number;
  readonly alternateSegmentPulse: boolean;
}

export function encodeTableEntry(e: InsulinTableEntry): Bytes {
  const high = (e.pulses >> 8) & 0b11;
  return new Uint8Array([(((e.segments - 1) << 4) + ((e.alternateSegmentPulse ? 1 : 0) << 3) + high) & 0xff, e.pulses & 0xff]);
}

export function decodeTableEntry(b: Bytes, o = 0): InsulinTableEntry {
  return {
    segments: (b[o]! >> 4) + 1,
    pulses: ((b[o]! & 0b11) << 8) + b[o + 1]!,
    alternateSegmentPulse: ((b[o]! >> 3) & 0x1) === 1,
  };
}

export function tableEntryChecksum(e: InsulinTableEntry): number {
  const perSegment = (e.pulses & 0xff) + (e.pulses >> 8);
  return perSegment * e.segments + (e.alternateSegmentPulse ? Math.trunc(e.segments / 2) : 0);
}

export const tableSegments = (entries: readonly InsulinTableEntry[]): number => entries.reduce((n, e) => n + e.segments, 0);

// ── rate rounding ───────────────────────────────────────────────────────────

/** Largest pod-supported basal rate (multiple of 0.05 U/h, max 30) not above `rate + 0.01`. */
export function roundToSupportedBasalRate(rate: number): number {
  const delta = 0.01;
  let k = Math.min(600, Math.max(0, Math.floor((rate + delta) * POD.pulsesPerUnit) + 1));
  while (k > 0 && k / POD.pulsesPerUnit > rate + delta) k--;
  return k / POD.pulsesPerUnit;
}

/** DASH and Omnipod 5 pods cannot deliver a true 0 U/h: they use the near-zero rate. */
export function roundToSupportedBasalTimingRate(rate: number, zeroBasalRate: number): number {
  const r = roundToSupportedBasalRate(rate);
  return r === 0 ? zeroBasalRate : r;
}

// ── basal table (scheduled basal and temp basal) ────────────────────────────

/** Half-hour segment table for a 24 h basal schedule given as `rateAt(offsetSeconds)`. */
export function basalTableFromSchedule(rateAt: (offsetSeconds: number) => number): InsulinTableEntry[] {
  const numSegments = 48;
  let halfPulseRemainder = false;
  const segments: number[] = [];
  for (let index = 0; index < numSegments; index++) {
    const rate = rateAt(index * SEGMENT_DURATION);
    const pulsesPerHour = Math.round(rate / POD.pulseSize);
    const pulsesPerSegment = pulsesPerHour >> 1;
    const halfPulse = (pulsesPerHour & 1) !== 0;
    segments.push(pulsesPerSegment + (halfPulseRemainder && halfPulse ? 1 : 0));
    halfPulseRemainder = halfPulseRemainder !== halfPulse;
  }

  const entries: InsulinTableEntry[] = [];
  const flush = (merged: readonly number[], alt: boolean) => {
    entries.push({ segments: merged.length, pulses: merged[0]!, alternateSegmentPulse: alt });
  };
  let alt = false;
  let toMerge: number[] = [];
  for (const pulses of segments) {
    const first = toMerge[0];
    if (first === undefined) {
      toMerge = [pulses];
      continue;
    }
    const delta = pulses - first;
    if (toMerge.length === 1) alt = delta === 1;
    const expectedDelta = alt ? toMerge.length % 2 : 0;
    if (expectedDelta !== delta || toMerge.length === MAX_SEGMENTS_PER_ENTRY) {
      flush(toMerge, alt);
      toMerge = [];
    }
    toMerge.push(pulses);
  }
  flush(toMerge, alt);
  return entries;
}

export function basalTableFromTempBasal(rate: number, durationSeconds: number): InsulinTableEntry[] {
  const pulsesPerHour = Math.round(rate / POD.pulseSize);
  const pulsesPerSegment = pulsesPerHour >> 1;
  const alternate = (pulsesPerHour & 1) !== 0;
  const entries: InsulinTableEntry[] = [];
  let remaining = Math.round(durationSeconds / SEGMENT_DURATION);
  while (remaining > 0) {
    const segments = Math.min(remaining, MAX_SEGMENTS_PER_ENTRY);
    entries.push({ segments, pulses: pulsesPerSegment, alternateSegmentPulse: segments > 1 ? alternate : false });
    remaining -= segments;
  }
  return entries;
}

/** Immediate bolus: one segment holding all pulses. */
export const immediateBolusTable = (units: number): InsulinTableEntry[] => [
  { segments: 1, pulses: Math.round(units / POD.pulseSize), alternateSegmentPulse: false },
];

// ── RateEntry (the "extra" commands) ────────────────────────────────────────

export interface RateEntry {
  readonly totalPulses: number;
  readonly delayBetweenPulses: number;
}

export const hundredthsOfMilliseconds = (seconds: number): number => seconds * 100000;
export const fromHundredthsOfMilliseconds = (v: number): number => v / 100000;

export function rateEntryRate(e: RateEntry): number {
  if (e.totalPulses === 0) return 0;
  return Math.round((HOUR / e.delayBetweenPulses / POD.pulsesPerUnit) * 100) / 100;
}

export function rateEntryDuration(e: RateEntry): number {
  if (e.totalPulses === 0) return 30 * MINUTE;
  return Math.round(e.delayBetweenPulses * e.totalPulses);
}

export function encodeRateEntry(e: RateEntry): Bytes {
  let delay = Math.trunc(hundredthsOfMilliseconds(e.delayBetweenPulses)) >>> 0;
  if (e.delayBetweenPulses === MAX_TIME_BETWEEN_PULSES && e.totalPulses !== 0) delay = (delay | NEAR_ZERO_BASAL_RATE_FLAG) >>> 0;
  const out = new Uint8Array(6);
  out.set(be16(Math.round(e.totalPulses * 10)), 0);
  out.set(be32(delay), 2);
  return out;
}

export function decodeRateEntry(b: Bytes, o: number): RateEntry {
  const totalPulses = u16be(b, o) / 10;
  const timer = (u32be(b, o + 2) & ~NEAR_ZERO_BASAL_RATE_FLAG) >>> 0;
  return { totalPulses, delayBetweenPulses: fromHundredthsOfMilliseconds(timer) };
}

/** Splits `rate` over `durationSeconds` into rate entries (port of `RateEntry.makeEntries`). */
export function makeRateEntries(rate: number, durationSeconds: number, zeroBasalRate: number): RateEntry[] {
  const maxPulsesPerEntry = 0xffff / 10;
  const entries: RateEntry[] = [];
  const rrate = roundToSupportedBasalTimingRate(rate, zeroBasalRate);
  const numHalfHours = Math.max(Math.round(durationSeconds / MINUTE / 30), 1);
  let remainingSegments = numHalfHours;
  const pulsesPerSegment = Math.round(rrate / POD.pulseSize) / 2;
  const maxSegmentsPerEntry = pulsesPerSegment > 0 ? Math.trunc(maxPulsesPerEntry / pulsesPerSegment) : 1;
  let remainingPulses = (rrate * numHalfHours) / 2 / POD.pulseSize;
  while (remainingSegments > 0) {
    if (rrate === 0) {
      entries.push({ totalPulses: 0, delayBetweenPulses: MAX_TIME_BETWEEN_PULSES });
      remainingSegments -= 1;
    } else if (rrate === POD.nearZeroBasalRate) {
      entries.push({ totalPulses: remainingSegments / 10, delayBetweenPulses: MAX_TIME_BETWEEN_PULSES });
      remainingSegments = 0;
    } else {
      const numSegments = Math.min(maxSegmentsPerEntry, Math.round(remainingPulses / pulsesPerSegment));
      remainingSegments -= numSegments;
      const pulseCount = pulsesPerSegment * numSegments;
      entries.push({ totalPulses: pulseCount, delayBetweenPulses: (HOUR / rrate) * POD.pulseSize });
      remainingPulses -= pulseCount;
    }
  }
  return entries;
}
