/**
 * Decoding of the realtime `glucoseData` plaintext (29 bytes) and the data-quality / sensor-condition
 * assessment around it.
 *
 * TypeScript port of RoundWhiteDiscKit `DataPlane/RealtimeGlucoseReading.swift` (MIT, (c) the
 * RoundWhiteDiscKit authors). Raw channels whose clinical meaning the source marks as provisional
 * (temperature, fast data) are kept as raw evidence only.
 */
import { i16le, u16le, type Bytes } from '@buddy/core';
import type { SensorLifecycle } from './lifecycle';

export const REALTIME_PLAINTEXT_SIZE = 29;

/** Raw 16-bit sensor value to displayable mg/dL: 1..38 shows as 39, 39..501 as is, 502..999 as 501. */
export type GlucoseValueStatus =
  | { readonly kind: 'valid'; readonly mgdl: number }
  | { readonly kind: 'belowRange'; readonly raw: number; readonly mgdl: 39 }
  | { readonly kind: 'aboveRange'; readonly raw: number; readonly mgdl: 501 }
  | { readonly kind: 'unavailable'; readonly raw: number };

export function glucoseValueStatus(raw: number): GlucoseValueStatus {
  if (raw >= 1 && raw < 39) return { kind: 'belowRange', raw, mgdl: 39 };
  if (raw >= 39 && raw <= 501) return { kind: 'valid', mgdl: raw };
  if (raw >= 502 && raw < 1000) return { kind: 'aboveRange', raw, mgdl: 501 };
  return { kind: 'unavailable', raw };
}

export const displayMgdl = (status: GlucoseValueStatus): number | null => (status.kind === 'unavailable' ? null : status.mgdl);

export type DataQualityError =
  | { readonly kind: 'good' }
  | { readonly kind: 'sensorTooHot' | 'sensorTooCold' | 'notDisplayable' | 'raw'; readonly raw: number };

export function dataQualityError(raw: number): DataQualityError {
  if (raw === 0) return { kind: 'good' };
  if ((raw & 0xe000) === 0xa000) return { kind: 'sensorTooHot', raw };
  if ((raw & 0xe000) === 0xc000) return { kind: 'sensorTooCold', raw };
  if ((raw & 0x8000) !== 0) return { kind: 'notDisplayable', raw };
  return { kind: 'raw', raw };
}

export type SensorCondition = 'ok' | 'invalid' | 'esa' | 'raw';
const sensorCondition = (raw: number): SensorCondition => (raw === 0 ? 'ok' : raw === 1 ? 'invalid' : raw === 2 ? 'esa' : 'raw');

export type Libre3TrendKind = 'notDetermined' | 'fallingQuickly' | 'falling' | 'stable' | 'rising' | 'risingQuickly' | 'raw';
const TRENDS: readonly Libre3TrendKind[] = ['notDetermined', 'fallingQuickly', 'falling', 'stable', 'rising', 'risingQuickly'];
const trendKind = (raw: number): Libre3TrendKind => TRENDS[raw] ?? 'raw';

export interface RealtimeGlucose {
  readonly lifeCount: number;
  readonly currentWord: number;
  readonly dqError: DataQualityError;
  readonly sensorConditionRaw: number;
  readonly sensorCondition: SensorCondition;
  readonly current: GlucoseValueStatus;
  /** Rate of change in mg/dL per minute, null when the sensor reports it unavailable (0x8000). */
  readonly rateOfChange: number | null;
  readonly trendRaw: number;
  readonly trend: Libre3TrendKind;
  readonly actionable: boolean;
  readonly temperatureStatus: number;
  readonly projectedGlucose: number;
  readonly historicalLifeCount: number;
  readonly historical: GlucoseValueStatus;
  readonly historicalDqError: DataQualityError;
  readonly temperature: number;
}

export function decodeRealtime(p: Bytes): RealtimeGlucose {
  if (p.length !== REALTIME_PLAINTEXT_SIZE) throw new Error(`Realtime glucose plaintext must be ${REALTIME_PLAINTEXT_SIZE} bytes, got ${p.length}`);
  const currentWord = u16le(p, 2);
  const historicalWord = u16le(p, 12);
  const trendByte = p[14]!;
  const rate = i16le(p, 4);
  return {
    lifeCount: u16le(p, 0),
    currentWord,
    dqError: dataQualityError((currentWord & 0x8000) === 0 ? 0 : currentWord),
    sensorConditionRaw: (currentWord >> 13) & 0x03,
    sensorCondition: sensorCondition((currentWord >> 13) & 0x03),
    current: glucoseValueStatus(u16le(p, 15)),
    rateOfChange: rate === -32768 ? null : rate / 100,
    trendRaw: trendByte & 0x07,
    trend: trendKind(trendByte & 0x07),
    actionable: (trendByte & 0x08) !== 0,
    temperatureStatus: u16le(p, 6),
    projectedGlucose: u16le(p, 8),
    historicalLifeCount: u16le(p, 10),
    historical: glucoseValueStatus(u16le(p, 17)),
    historicalDqError: dataQualityError((historicalWord & 0x8000) === 0 ? 0 : historicalWord),
    temperature: u16le(p, 19),
  };
}

export type QualityIssue =
  | { readonly kind: 'sensorWarmup'; readonly remainingMinutes: number }
  | { readonly kind: 'sensorExpired' }
  | { readonly kind: 'currentGlucoseUnavailable' }
  | { readonly kind: 'currentDataQuality'; readonly error: DataQualityError }
  | { readonly kind: 'sensorCondition'; readonly condition: SensorCondition }
  | { readonly kind: 'notActionable' };

export interface QualityAssessment {
  readonly isUsable: boolean;
  readonly issues: readonly QualityIssue[];
  readonly blocking: readonly QualityIssue[];
  /** Surfaced but not suppressing (currently only `notActionable`). */
  readonly advisories: readonly QualityIssue[];
}

/** Blocking: warmup, expiry, unavailable value, data-quality error, abnormal sensor condition. */
export function assessRealtime(reading: RealtimeGlucose, lifecycle: SensorLifecycle | null): QualityAssessment {
  const issues: QualityIssue[] = [];
  if (lifecycle) {
    if (lifecycle.isExpired) issues.push({ kind: 'sensorExpired' });
    else if (lifecycle.isWarmingUp) issues.push({ kind: 'sensorWarmup', remainingMinutes: lifecycle.remainingWarmupMinutes });
  }
  if (reading.current.kind === 'unavailable') issues.push({ kind: 'currentGlucoseUnavailable' });
  if (reading.dqError.kind !== 'good') issues.push({ kind: 'currentDataQuality', error: reading.dqError });
  if (reading.sensorCondition !== 'ok') issues.push({ kind: 'sensorCondition', condition: reading.sensorCondition });
  if (!reading.actionable) issues.push({ kind: 'notActionable' });
  const advisories = issues.filter((i) => i.kind === 'notActionable');
  const blocking = issues.filter((i) => i.kind !== 'notActionable');
  return { isUsable: blocking.length === 0, issues, blocking, advisories };
}
