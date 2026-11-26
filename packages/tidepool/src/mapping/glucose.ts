import type { GlucoseReading, Trend } from '@buddy/core';
import { isoTime, round } from '../encoding';
import type { CbgDatum, MappedDatum, SmbgDatum, TidepoolTrend } from '../types';
import { datumId, originOf, resolvedRecordId, type MappingContext } from './context';

/** Tidepool accepts 0 to 1000 mg/dL (TidepoolKit `TBloodGlucose.valueRange`). */
export const MAX_GLUCOSE_MGDL = 1000;

/** Dexcom-style arrows to Loop's seven trends (as TidepoolService maps `GlucoseTrend`). */
const TRENDS: Readonly<Record<Exclude<Trend, 'unknown'>, TidepoolTrend>> = {
  doubleUp: 'rapidRise',
  singleUp: 'moderateRise',
  fortyFiveUp: 'slowRise',
  flat: 'constant',
  fortyFiveDown: 'slowFall',
  singleDown: 'moderateFall',
  doubleDown: 'rapidFall',
};

export const trendOf = (trend: Trend | undefined): TidepoolTrend | undefined => (trend && trend !== 'unknown' ? TRENDS[trend] : undefined);

/** Readings that came from a Nightscout CGM source are never sent back out (same rule as the Nightscout uploader). */
const isNightscoutSource = (source: string): boolean => source === 'nightscout' || source.startsWith('nightscout-');

/** Stable identity of a reading: the store keys readings by source and time. */
export const glucoseSyncId = (r: GlucoseReading): string => `${r.source}:${r.date}`;

export function mapGlucose(r: GlucoseReading, ctx: MappingContext): MappedDatum<CbgDatum | SmbgDatum> | null {
  if (!Number.isFinite(r.value) || !Number.isFinite(r.date) || r.value <= 0) return null;
  const syncId = glucoseSyncId(r);
  if (ctx.excludeId ? ctx.excludeId(syncId) : isNightscoutSource(r.source)) return null;
  const resolved = resolvedRecordId(ctx, syncId);
  const value = round(Math.min(r.value, MAX_GLUCOSE_MGDL), 3);
  const base = {
    time: isoTime(r.date),
    id: datumId(ctx, resolved),
    origin: originOf(ctx, resolved),
    ...(ctx.deviceIds?.cgm ? { deviceId: ctx.deviceIds.cgm } : {}),
    payload: { syncIdentifier: syncId },
    value,
    units: 'mg/dL' as const,
  };
  const manual = (ctx.manualGlucoseSources ?? ['manual']).includes(r.source);
  if (manual) return { revisedAt: r.date, datum: { ...base, type: 'smbg', subType: 'manual' } };
  const trend = trendOf(r.trend);
  return { revisedAt: r.date, datum: { ...base, type: 'cbg', ...(trend ? { trend } : {}) } };
}

export const mapGlucoseReadings = (readings: readonly GlucoseReading[], ctx: MappingContext): MappedDatum<CbgDatum | SmbgDatum>[] =>
  readings.flatMap((r) => {
    const m = mapGlucose(r, ctx);
    return m ? [m] : [];
  });
