/**
 * Port of Trio's fat/protein unit (FPU) handling (`BaseCarbsStorage.processFPU` and
 * `splitIntoCarbEquivalents`): fat and protein become up to three delayed carb-equivalent
 * entries. Pure TS.
 */

const MINUTE = 60_000;
const EPS = 1e-9;

export const FPU_MAX_TOTAL_GRAMS = 99;
export const FPU_MAX_ENTRIES = 3;
export const FPU_MAX_PER_ENTRY = 33;
export const FPU_MIN_PER_ENTRY = 10;

/** Trio's `PickerSetting` ranges; stored values are clamped to them like Trio does. */
export const FPU_RANGES = {
  individualAdjustmentFactor: { min: 0.1, max: 1.2, step: 0.05, default: 0.5 },
  delay: { min: 15, max: 120, step: 5, default: 60 },
  minuteInterval: { min: 30, max: 60, step: 5, default: 30 },
} as const;

export interface FpuSettings {
  /** "Fat and Protein Percentage" (0.1–1.2). */
  readonly individualAdjustmentFactor: number;
  /** "Fat and Protein Delay", minutes. */
  readonly delay: number;
  /** "Spread Interval", minutes. */
  readonly minuteInterval: number;
}

export interface CarbEquivalent {
  readonly date: number;
  readonly grams: number;
}

const clamp = (v: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, v));

/** Splits total grams into ≤ 3 near-equal integer entries of 10–33 g. */
export function splitIntoCarbEquivalents(total: number, maxEntries = FPU_MAX_ENTRIES, maxPerEntry = FPU_MAX_PER_ENTRY, minPerEntry = FPU_MIN_PER_ENTRY): number[] {
  if (total < minPerEntry) return [];
  const needed = Math.floor((total + maxPerEntry - 1) / maxPerEntry);
  const count = Math.min(maxEntries, Math.max(1, needed));
  const base = Math.floor(total / count);
  const rem = total % count;
  let buckets = Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));

  if (buckets.length > 1) {
    const merged = [...buckets];
    for (let i = merged.length - 1; i >= 1; i--) {
      const v = merged[i]!;
      if (v > 0 && v < minPerEntry) {
        merged[i - 1] = merged[i - 1]! + v;
        merged[i] = 0;
      }
    }
    buckets = merged.filter((b) => b > 0);
  }
  return buckets.map((b) => Math.min(maxPerEntry, b)).filter((b) => b >= minPerEntry);
}

/** Total carb equivalents: ⌊(fat × 9 + protein × 4) / 10 × factor⌋, capped at 99 g. */
export function carbEquivalentGrams(fat: number, protein: number, factor: number): number {
  const adjustment = clamp(factor, FPU_RANGES.individualAdjustmentFactor);
  const kcal = protein * 4 + fat * 9;
  const raw = Math.floor((kcal / 10) * adjustment + EPS);
  return Math.min(FPU_MAX_TOTAL_GRAMS, Math.max(0, raw));
}

/**
 * Future carb-equivalent entries for a meal at `mealDate`: first after the delay, then
 * one per spread interval. Empty when the equivalents are below 10 g.
 */
export function fpuCarbEquivalents(fat: number, protein: number, mealDate: number, s: FpuSettings): CarbEquivalent[] {
  if (!(fat > 0 || protein > 0)) return [];
  const total = carbEquivalentGrams(fat, protein, s.individualAdjustmentFactor);
  if (total < FPU_MIN_PER_ENTRY) return [];
  const delay = clamp(s.delay, FPU_RANGES.delay);
  const spacing = clamp(s.minuteInterval, FPU_RANGES.minuteInterval) * MINUTE;
  const start = mealDate + delay * MINUTE;
  return splitIntoCarbEquivalents(total).map((grams, i) => ({ date: start + i * spacing, grams }));
}
