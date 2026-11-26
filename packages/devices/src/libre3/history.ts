/**
 * Historical backfill pages, clinical records and the patch-control commands that request them.
 *
 * TypeScript port of RoundWhiteDiscKit `DataPlane/HistoricalReadingPage.swift`,
 * `ClinicalReadingRecord.swift` and `PatchControlCommand.swift` (MIT, (c) the RoundWhiteDiscKit
 * authors).
 */
import { u16le, type Bytes } from '@buddy/core';
import { displayMgdl, glucoseValueStatus } from './realtime';

export const HISTORIC_SAMPLE_SPACING = 5;

export interface HistoricalSample {
  readonly lifeCount: number;
  readonly rawValue: number;
  readonly mgdl: number | null;
}

export interface HistoricalPage {
  readonly startLifeCount: number;
  readonly endLifeCount: number;
  readonly samples: readonly HistoricalSample[];
}

/** 14-byte page: `startLifeCount_LE2 || value0..value5` (six samples, 5 life-count minutes apart). */
export function decodeHistoricalPage(p: Bytes): HistoricalPage {
  if (p.length !== 14) throw new Error(`Historical page plaintext must be 14 bytes, got ${p.length}`);
  const start = u16le(p, 0);
  const samples = Array.from({ length: 6 }, (_, i): HistoricalSample => {
    const rawValue = u16le(p, 2 + i * 2);
    return { lifeCount: start + i * HISTORIC_SAMPLE_SPACING, rawValue, mgdl: displayMgdl(glucoseValueStatus(rawValue)) };
  });
  return { startLifeCount: start, endLifeCount: start + 5 * HISTORIC_SAMPLE_SPACING, samples };
}

export interface ClinicalRecord {
  readonly lifeCount: number;
  readonly currentGlucoseRaw: number;
  readonly historicGlucoseRaw: number;
  readonly currentMgdl: number | null;
}

/** 14-byte per-minute record; word 5 is the current-minute glucose keyed at the record's own life count. */
export function decodeClinicalRecord(p: Bytes): ClinicalRecord {
  if (p.length !== 14) throw new Error(`Clinical record plaintext must be 14 bytes, got ${p.length}`);
  const currentGlucoseRaw = u16le(p, 10);
  return { lifeCount: u16le(p, 0), currentGlucoseRaw, historicGlucoseRaw: u16le(p, 12), currentMgdl: displayMgdl(glucoseValueStatus(currentGlucoseRaw)) };
}

export type BackfillStream = 'historical' | 'clinical';

/** 7-byte `patchControl` plaintext: `01 stream selector lifeCount_LE2 00 00` (>= lifeCount). */
export function backfillCommand(stream: BackfillStream, lifeCount: number, selector = 0x01): Bytes {
  return Uint8Array.of(0x01, stream === 'historical' ? 0x00 : 0x01, selector, lifeCount & 0xff, (lifeCount >> 8) & 0xff, 0x00, 0x00);
}

export const eventLogCommand = (index: number): Bytes => Uint8Array.of(0x04, index & 0xff, 0, 0, 0, 0, 0);
export const factoryDataCommand = (): Bytes => Uint8Array.of(0x06, 0, 0, 0, 0, 0, 0);
/** Terminal command (end of session). Not used for routine disconnect, reconnect or backfill; never sent by this driver. */
export const shutdownPatchCommand = (): Bytes => Uint8Array.of(0x05, 0, 0, 0, 0, 0, 0);
