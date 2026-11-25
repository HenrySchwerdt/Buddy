import { carbsAbsorbedBetween, projectIob, scheduleValueAt, MINUTE, type AlgorithmInput } from '@buddy/core';

export interface PredictionOptions {
  readonly horizonMinutes: number;
  /** Minutes over which the current glucose momentum fades to zero. */
  readonly momentumMinutes: number;
  /** Assume a zero temp from now (worst-case low prediction). */
  readonly zeroTemp?: boolean;
  /** Include logged carbs. */
  readonly includeCarbs?: boolean;
}

/**
 * Simple additive effect model (insulin + carbs + fading momentum), 5-minute steps.
 * Deliberately transparent so new algorithms can reuse and reason about it.
 */
export function predictGlucose(input: AlgorithmInput, o: PredictionOptions): number[] {
  const { profile, now, glucoseStatus } = input;
  const iob = projectIob(input.doses, profile, now, o.horizonMinutes, o.zeroTemp ?? false);
  const out = [glucoseStatus.glucose];
  const steps = o.horizonMinutes / 5;
  for (let i = 1; i <= steps; i++) {
    const t0 = now + (i - 1) * 5 * MINUTE;
    const t1 = now + i * 5 * MINUTE;
    const isf = scheduleValueAt(profile.isf, t0, profile.utcOffsetMinutes);
    const cr = scheduleValueAt(profile.carbRatio, t0, profile.utcOffsetMinutes);
    const insulinEffect = -(iob[i - 1]!.activity * 5) * isf;
    const carbEffect = o.includeCarbs === false ? 0 : carbsAbsorbedBetween(input.carbs.filter((c) => c.date <= now), t0, t1) * (isf / cr);
    const fade = Math.max(0, 1 - (i * 5) / Math.max(5, o.momentumMinutes));
    const momentum = glucoseStatus.delta * fade;
    const next = Math.max(39, Math.min(401, out[i - 1]! + insulinEffect + carbEffect + momentum));
    out.push(Math.round(next));
  }
  return out;
}

export const minOf = (xs: readonly number[]): number => xs.reduce((a, b) => Math.min(a, b), Infinity);
