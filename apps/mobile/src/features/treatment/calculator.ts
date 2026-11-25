/**
 * Port of Trio's bolus calculator (`BaseBolusCalculationManager.calculateInsulin`,
 * `APSManager.roundBolus` and the glucose-delta window of `TreatmentsStateModel`).
 * Pure TypeScript, no React Native imports, so it runs under vitest.
 *
 * All glucose values are mg/dL; all times are epoch milliseconds.
 */

const MINUTE = 60_000;
/** Trio: no recommendation when the last successful loop is older than this. */
export const LOOP_STALE_MS = 15 * MINUTE;
/** Trio: no recommendation when current or minimum predicted glucose is below this (mg/dL). */
export const VERY_LOW_GLUCOSE = 54;
/** Trio: glucose delta uses readings newer than this. */
export const DELTA_WINDOW_MS = 20 * MINUTE;
/** Trio default for Preferences.maxCOB. */
export const DEFAULT_MAX_COB = 120;
/** Absorbs binary floating-point noise before flooring (Trio uses exact Decimal maths). */
const EPS = 1e-9;

export interface CalculationInput {
  /** Carbs entered on the sheet (0 when the entry is backdated). */
  readonly carbs: number;
  /** Latest glucose, 0 when there is none. */
  readonly currentBG: number;
  /** Change between newest and oldest reading in the last 20 minutes. */
  readonly deltaBG: number;
  readonly target: number;
  readonly isf: number;
  readonly carbRatio: number;
  readonly iob: number;
  /** Carbs on board, g. */
  readonly cob: number;
  readonly useFattyMealCorrectionFactor: boolean;
  readonly fattyMealFactor: number;
  readonly useSuperBolus: boolean;
  readonly sweetMealFactor: number;
  /** Scheduled basal rate, U/h (super bolus). */
  readonly basal: number;
  /** Recommended Bolus Percentage, 0–1. */
  readonly fraction: number;
  readonly maxBolus: number;
  readonly maxIOB: number;
  readonly maxCOB: number;
  readonly minPredBG: number;
  /** Date of the last successful loop, null when there is none. */
  readonly lastLoopDate: number | null;
  readonly now: number;
  /** Pump bolus increment in U; null when no pump is connected (Trio then skips rounding). */
  readonly bolusIncrement: number | null;
}

export interface CalculationResult {
  /** Final recommendation, limited and rounded for the pump. */
  readonly insulinCalculated: number;
  /** After Recommended Bolus %, Reduced Bolus % and Super Bolus. */
  readonly factoredInsulin: number;
  /** Sum of all parts before factors. */
  readonly wholeCalc: number;
  readonly iobInsulinReduction: number;
  readonly superBolusInsulin: number;
  readonly targetDifference: number;
  readonly targetDifferenceInsulin: number;
  readonly fifteenMinutesInsulin: number;
  /** COB + new carbs, capped at Max COB. */
  readonly wholeCob: number;
  readonly wholeCobInsulin: number;
}

export const EMPTY_RESULT: CalculationResult = {
  insulinCalculated: 0,
  factoredInsulin: 0,
  wholeCalc: 0,
  iobInsulinReduction: 0,
  superBolusInsulin: 0,
  targetDifference: 0,
  targetDifferenceInsulin: 0,
  fifteenMinutesInsulin: 0,
  wholeCob: 0,
  wholeCobInsulin: 0,
};

/**
 * `APSManager.roundBolus`: rounds down to a deliverable pump volume and never above the
 * (rounded) Max Bolus. Without a pump Trio returns the amount unchanged.
 * Deviation: negative amounts are clamped to 0 (LoopKit's behaviour is pump specific).
 */
export function roundBolus(amount: number, increment: number | null, maxBolus: number): number {
  const positive = Math.max(0, amount);
  if (!increment || increment <= 0) return positive;
  const floorTo = (x: number) => Number((Math.floor(x / increment + EPS) * increment).toFixed(4));
  return Math.min(floorTo(positive), floorTo(maxBolus));
}

/** `calculateInsulin(input:)` of Trio's BolusCalculationManager, line by line. */
export function calculateInsulin(input: CalculationInput): CalculationResult {
  const targetDifference = input.currentBG - input.target;
  const targetDifferenceInsulin = targetDifference / input.isf;
  const fifteenMinutesInsulin = input.deltaBG / input.isf;

  const wholeCob = Math.min(input.cob + input.carbs, input.maxCOB);
  const wholeCobInsulin = wholeCob / input.carbRatio;

  const iobInsulinReduction = -1 * input.iob;

  let wholeCalc: number;
  if (input.deltaBG !== 0) {
    wholeCalc = targetDifferenceInsulin + iobInsulinReduction + wholeCobInsulin + fifteenMinutesInsulin;
  } else if (input.currentBG === 0) {
    wholeCalc = iobInsulinReduction + wholeCobInsulin;
  } else {
    wholeCalc = targetDifferenceInsulin + iobInsulinReduction + wholeCobInsulin;
  }

  let factoredInsulin = wholeCalc;
  if (factoredInsulin > 0) {
    factoredInsulin *= input.fraction;
    if (input.useFattyMealCorrectionFactor) factoredInsulin *= input.fattyMealFactor;
  }

  let superBolusInsulin = 0;
  if (input.useSuperBolus) {
    superBolusInsulin = input.sweetMealFactor * input.basal;
    factoredInsulin += superBolusInsulin;
  }

  const isLoopStale = input.lastLoopDate == null || input.now - input.lastLoopDate > LOOP_STALE_MS;
  let insulinCalculated: number;
  if (input.currentBG < VERY_LOW_GLUCOSE || input.minPredBG < VERY_LOW_GLUCOSE || isLoopStale) {
    insulinCalculated = 0;
  } else {
    insulinCalculated = Math.max(factoredInsulin, 0);
    insulinCalculated = Math.min(insulinCalculated, input.maxBolus);
    insulinCalculated = Math.min(insulinCalculated, input.maxIOB - input.iob);
    insulinCalculated = roundBolus(insulinCalculated, input.bolusIncrement, input.maxBolus);
  }

  return {
    insulinCalculated,
    factoredInsulin,
    wholeCalc,
    iobInsulinReduction,
    superBolusInsulin,
    targetDifference,
    targetDifferenceInsulin,
    fifteenMinutesInsulin,
    wholeCob,
    wholeCobInsulin,
  };
}

/**
 * Trio's delta: newest minus oldest reading among those newer than 20 minutes.
 * Fewer than two readings in the window → 0. `readings` may be in any order.
 */
export function glucoseDelta(readings: readonly { readonly date: number; readonly value: number }[], now: number): number {
  const recent = readings.filter((r) => r.date > now - DELTA_WINDOW_MS).sort((a, b) => b.date - a.date);
  if (recent.length < 2) return 0;
  return recent[0]!.value - recent[recent.length - 1]!.value;
}

/** `TreatmentsStateModel.algorithmSuggestedBolus`: insulinReq × Recommended % capped at Max Bolus. */
export function algorithmSuggestedBolus(insulinReq: number | undefined, fraction: number, maxBolus: number): number {
  if (!insulinReq || insulinReq <= 0) return 0;
  return Math.min(insulinReq * fraction, maxBolus);
}

/** Trio: an entry counts as backdated when its date differs from the sheet's opening time by more than 1 s. */
export function isBackdated(date: number, defaultDate: number): boolean {
  return Math.abs(date - defaultDate) > 1000;
}
