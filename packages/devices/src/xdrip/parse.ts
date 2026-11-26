import type { Trend } from '@buddy/core';
import { trendFromDirection } from '../trend';
import type { XdripNativeReading } from './bridge';

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** LoopKit `GlucoseTrend` raw values as Trio decodes them (the Dexcom 1..7 scale). */
export function trendFromGlucoseTrendCode(code: unknown): Trend {
  switch (code) {
    case 1: return 'doubleUp';
    case 2: return 'singleUp';
    case 3: return 'fortyFiveUp';
    case 4: return 'flat';
    case 5: return 'fortyFiveDown';
    case 6: return 'singleDown';
    case 7: return 'doubleDown';
    default: return 'unknown';
  }
}

/** Direction name (preferred) or numeric code to a Buddy trend; xDrip's "NOT COMPUTABLE" / "NONE" map to unknown. */
export function xdripTrend(r: Pick<XdripNativeReading, 'direction' | 'trend'>): Trend {
  if (typeof r.direction === 'string' && r.direction !== '') return trendFromDirection(r.direction);
  return trendFromGlucoseTrendCode(r.trend);
}

/** xDrip4iOS date strings look like `/Date(1462404576000)/`, optionally with a time-zone suffix (`+0200`), which does not change the instant. */
export function parseXdripDate(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /\(\s*(-?\d+)/.exec(raw);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isSafeInteger(ms) ? ms : null;
}

function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function trendCodeOf(row: Record<string, unknown>): number | undefined {
  // Dexcom changed the trend format in 2021; Trio accepts `trend` / `Trend` as Int or numeric String.
  const n = numberOf(row.trend ?? row.Trend);
  return n === null ? undefined : n;
}

/**
 * Parses the `latestReadings` value xDrip4iOS writes to the shared app group, in both shapes Trio accepts:
 * a top-level array of readings (legacy) or a dictionary carrying them under `recentReadings` (extended).
 * Rows that do not parse are skipped (not repaired). Throws only when the payload is not JSON or not either shape.
 */
export function parseXdripAppGroupJson(json: string): XdripNativeReading[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new Error('xDrip: the shared app-group data is not valid JSON.');
  }
  const rows = Array.isArray(decoded) ? decoded : asRecord(decoded) && Array.isArray(asRecord(decoded)?.recentReadings) ? (asRecord(decoded)!.recentReadings as unknown[]) : null;
  if (!rows) throw new Error('xDrip: the shared app-group data has an unexpected shape.');
  const out: XdripNativeReading[] = [];
  for (const entry of rows) {
    const row = asRecord(entry);
    if (!row) continue;
    // Trio ignores rows tagged for another source; xDrip4iOS itself tags none or "xDrip".
    if (typeof row.from === 'string' && row.from !== 'xDrip') continue;
    const value = numberOf(row.Value);
    const date = parseXdripDate(row.DT);
    if (value === null || date === null) continue;
    const direction = typeof row.direction === 'string' ? row.direction : undefined;
    const trend = trendCodeOf(row);
    out.push({ value, date, ...(direction !== undefined ? { direction } : {}), ...(trend !== undefined ? { trend } : {}) });
  }
  return out;
}
