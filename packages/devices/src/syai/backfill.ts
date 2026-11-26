/**
 * TypeScript port of the grid and backfill-range arithmetic of CGMManager+Ingest.swift from
 * SyaiKit (MIT, © 2026 Nightscout Foundation).
 *
 * The sensor emits one record per minute. Only every 5th record (by the sensor's own counter,
 * live or backfilled) is forwarded, so both sources share one grid and never interleave.
 */
import { recordLength } from './frames';

/** One forwarded reading per this many sensor records (1 record = 1 min). */
export const FORWARD_GRID_STEP = 5;

export const isOnForwardGrid = (sequence: number): boolean => sequence % FORWARD_GRID_STEP === 0;

/**
 * Warmup is judged by the sensor's own elapsed field, not `date - activatedAt` and not an index
 * range: index 0 sits at different offsets on V1.6 (60 s) and V1.7 (62 s).
 */
export const isWarmup = (elapsedSec: number | null, preheatSec: number | null): boolean =>
  elapsedSec !== null && preheatSec !== null && elapsedSec <= preheatSec;

export const isPastWear = (elapsedSec: number | null, activeSec: number | null): boolean =>
  elapsedSec !== null && activeSec !== null && elapsedSec >= activeSec;

/** First sequence worth requesting: warmup-era records are always dropped on arrival. */
export const firstBackfillableSequence = (preheatSec: number): number => Math.min(Math.max(0, preheatSec / 60), 0xffff);

/** Bytes of one history notify packet (ATT MTU cap), header included. */
export const HISTORY_PACKET_BYTES = 176;

/**
 * Records that fit one history packet: asking for more makes the sensor page, and one V1.7 build
 * mis-serves paged responses (readings land on the wrong minutes). 18 at 9 B/record (V1.7 and
 * unknown versions), 20 at 8 B/record (confirmed V1.6 only).
 */
export const maxBackfillRequestCount = (parseVersion: string): number => (parseVersion === 'V1.6' ? 20 : 18);

export interface BackfillRange {
  readonly start: number;
  readonly count: number;
  /** Where the next live sample should resume when the hole is wider than one request. */
  readonly remaining: number | null;
}

const nextOnGrid = (sequence: number): number => sequence + ((FORWARD_GRID_STEP - (sequence % FORWARD_GRID_STEP)) % FORWARD_GRID_STEP);

/**
 * Records a backfill request should ask for, given the newest grid record held (`have`) and the
 * live sequence that just arrived (`newest`, excluded: it is already ingested). Both ends snap to
 * the grid; a hole with no grid record in it is not requested at all.
 */
export function backfillRange(have: number, newest: number, firstRequestable: number, maxCount: number): BackfillRange | null {
  if (maxCount <= 0) return null;
  const start = nextOnGrid(Math.max(have + 1, Math.floor(firstRequestable)));
  const last = Math.trunc((newest - 1) / FORWARD_GRID_STEP) * FORWARD_GRID_STEP;
  if (last < start) return null;
  // Chunked walks stop on a grid index too, so resuming from `remaining` cannot skip records.
  const end = Math.min(last, Math.trunc((start + maxCount - 1) / FORWARD_GRID_STEP) * FORWARD_GRID_STEP);
  if (end < start) return null;
  return { start, count: end - start + 1, remaining: end < last ? end : null };
}

/** Sanity check used by tests: a request of `maxBackfillRequestCount` records fits one packet. */
export const fitsOnePacket = (parseVersion: string): boolean => maxBackfillRequestCount(parseVersion) * recordLength(parseVersion) <= HISTORY_PACKET_BYTES - 8;
