/**
 * Sensor lifecycle (warmup / active / expired) and the patch-status record with the sensor
 * error / attention decoding.
 *
 * TypeScript port of RoundWhiteDiscKit `DataPlane/SensorLifecycle.swift` and
 * `DataPlane/PatchStatus.swift` (MIT, (c) the RoundWhiteDiscKit authors), plus the attention
 * downgrade rules of LibreLoop `LibreLoopCGMManager+Pairing.swift` (MIT, (c) the LibreLoop authors).
 */
import { i16le, type Bytes } from '@buddy/core';

export const DEFAULT_WARMUP_MINUTES = 60;

export type LifecyclePhase = 'warmup' | 'active' | 'expired';

export class SensorLifecycle {
  readonly elapsedMinutes: number;
  constructor(
    readonly currentLifeCountMinutes: number,
    readonly warmupDurationMinutes = DEFAULT_WARMUP_MINUTES,
    readonly wearDurationMinutes: number | null = null,
  ) {
    this.elapsedMinutes = Math.max(0, currentLifeCountMinutes);
  }
  get remainingWarmupMinutes(): number {
    return Math.max(0, this.warmupDurationMinutes - this.elapsedMinutes);
  }
  get remainingWearMinutes(): number | null {
    return this.wearDurationMinutes === null ? null : Math.max(0, this.wearDurationMinutes - this.elapsedMinutes);
  }
  get isWarmupComplete(): boolean {
    return this.elapsedMinutes >= this.warmupDurationMinutes;
  }
  get isExpired(): boolean {
    return this.wearDurationMinutes !== null && this.elapsedMinutes >= this.wearDurationMinutes;
  }
  get isWarmingUp(): boolean {
    return !this.isWarmupComplete && !this.isExpired;
  }
  get phase(): LifecyclePhase {
    return this.isExpired ? 'expired' : this.isWarmupComplete ? 'active' : 'warmup';
  }
}

export type SensorError = 'none' | 'insertionFailure' | 'expired' | 'terminated' | 'transmissionError' | 'unknown';
export type SensorAttention = 'none' | 'checkSensor' | 'sensorEnded' | 'replaceSensor' | 'unknown';

export function sensorError(code: number): SensorError {
  switch (code) {
    case 0: return 'none';
    case 3: return 'insertionFailure';
    case 5: return 'expired';
    case 6:
    case 8: return 'terminated';
    case 7: return 'transmissionError';
    default: return 'unknown';
  }
}

/** `errorData` first; with no error the patch state decides (3 check, 5/6 ended, 7/8 replace). */
export function sensorAttention(errorData: number, patchState: number): SensorAttention {
  switch (errorData) {
    case 0: break;
    case 3:
    case 7: return 'checkSensor';
    case 5:
    case 6: return 'sensorEnded';
    case 8: return 'replaceSensor';
    default: return 'unknown';
  }
  if (patchState === 3) return 'checkSensor';
  if (patchState === 7 || patchState === 8) return 'replaceSensor';
  if (patchState === 5 || patchState === 6) return 'sensorEnded';
  return 'none';
}

export interface PatchStatus {
  readonly lifeCount: number;
  readonly errorData: number;
  readonly eventData: number;
  readonly index: number;
  readonly patchState: number;
  /** Sensor age in minutes. */
  readonly currentLifeCount: number;
  readonly stackDisconnectReason: number;
  readonly appDisconnectReason: number;
  readonly sensorError: SensorError;
  /** Raw attention from the protocol notes; use `effectiveAttention` for policy. */
  readonly attention: SensorAttention;
  /**
   * Attention after the LibreLoop rules: a transient transmission error (7) and an error code on a
   * still-active sensor (history of the event log, not live state) only ask to check the sensor.
   */
  readonly effectiveAttention: SensorAttention;
}

export const PATCH_STATUS_PLAINTEXT_SIZE = 12;
const toInt8 = (b: number): number => (b << 24) >> 24;

export function decodePatchStatus(p: Bytes): PatchStatus {
  if (p.length !== PATCH_STATUS_PLAINTEXT_SIZE) throw new Error(`Patch status plaintext must be ${PATCH_STATUS_PLAINTEXT_SIZE} bytes, got ${p.length}`);
  const errorData = i16le(p, 2);
  const patchState = toInt8(p[7]!);
  const error = sensorError(errorData);
  const attention = sensorAttention(errorData, patchState);
  const erroredWhileActive = patchState === 4 && errorData !== 0;
  return {
    lifeCount: i16le(p, 0),
    errorData,
    eventData: 4000 + i16le(p, 4),
    index: toInt8(p[6]!),
    patchState,
    currentLifeCount: i16le(p, 8),
    stackDisconnectReason: toInt8(p[10]!),
    appDisconnectReason: toInt8(p[11]!),
    sensorError: error,
    attention,
    effectiveAttention: error === 'transmissionError' || erroredWhileActive ? 'checkSensor' : attention,
  };
}

/** States 6 and 8 are the post-shutdown states; 3/5/7 are expiry/error handling states. */
export const isPatchTerminated = (s: PatchStatus): boolean => s.patchState === 6 || s.patchState === 8 || s.sensorError === 'terminated';
