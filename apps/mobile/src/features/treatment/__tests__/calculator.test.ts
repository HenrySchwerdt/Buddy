import { describe, expect, it } from 'vitest';
import { algorithmSuggestedBolus, calculateInsulin, glucoseDelta, isBackdated, roundBolus, type CalculationInput } from '../calculator';
import { carbEquivalentGrams, fpuCarbEquivalents, splitIntoCarbEquivalents } from '../fpu';
import {
  bolusWarning,
  formatGlucoseDelta,
  insulinFormatter,
  isRoundedForPump,
  limitExceededLabel,
  parseDecimal,
  progressText,
  recommendationWarning,
  treatmentButtonLabel,
  wrapNegative,
  type TreatmentButtonState,
} from '../formatting';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

/** Values from Trio's Bolus Calculator Details reference screenshot (treatment-02). */
const base: CalculationInput = {
  carbs: 0,
  currentBG: 159,
  deltaBG: 16,
  target: 110,
  isf: 200,
  carbRatio: 30,
  iob: 0,
  cob: 0,
  useFattyMealCorrectionFactor: false,
  fattyMealFactor: 0.7,
  useSuperBolus: false,
  sweetMealFactor: 1,
  basal: 1,
  fraction: 0.7,
  maxBolus: 10,
  maxIOB: 6,
  maxCOB: 120,
  minPredBG: 120,
  lastLoopDate: NOW - 2 * MIN,
  now: NOW,
  bolusIncrement: 0.05,
};

const calc = (patch: Partial<CalculationInput> = {}) => calculateInsulin({ ...base, ...patch });

describe('Trio bolus calculator parts', () => {
  it('glucose part: (current − target) / ISF', () => {
    const r = calc();
    expect(r.targetDifference).toBe(49);
    expect(r.targetDifferenceInsulin).toBeCloseTo(0.245, 10);
    expect(insulinFormatter(r.targetDifferenceInsulin, 'down', false, 'en')).toBe('0.24');
  });

  it('glucose part is negative below target', () => {
    expect(calc({ currentBG: 90 }).targetDifferenceInsulin).toBeCloseTo(-0.1, 10);
  });

  it('IOB part: −1 × IOB', () => {
    const r = calc({ iob: 1.25 });
    expect(r.iobInsulinReduction).toBe(-1.25);
    expect(r.wholeCalc).toBeCloseTo(0.245 - 1.25 + 0.08, 10);
  });

  it('COB part: (COB + carbs) / CR', () => {
    const r = calc({ cob: 20, carbs: 40, carbRatio: 10 });
    expect(r.wholeCob).toBe(60);
    expect(r.wholeCobInsulin).toBe(6);
  });

  it('COB part is capped at Max COB', () => {
    const r = calc({ cob: 100, carbs: 60, carbRatio: 10 });
    expect(r.wholeCob).toBe(120);
    expect(r.wholeCobInsulin).toBe(12);
  });

  it('15-min trend part: delta / ISF', () => {
    expect(calc().fifteenMinutesInsulin).toBeCloseTo(0.08, 10);
    expect(calc({ deltaBG: -20 }).fifteenMinutesInsulin).toBeCloseTo(-0.1, 10);
  });

  it('without a delta the trend part is left out', () => {
    expect(calc({ deltaBG: 0 }).wholeCalc).toBeCloseTo(0.245, 10);
  });

  it('without glucose only IOB and COB count', () => {
    const r = calc({ deltaBG: 0, currentBG: 0, iob: 0.5, carbs: 30, carbRatio: 10 });
    expect(r.wholeCalc).toBeCloseTo(2.5, 10);
    expect(r.insulinCalculated).toBe(0); // BG 0 < 54 → no recommendation
  });

  it('full bolus sums all parts', () => {
    expect(calc().wholeCalc).toBeCloseTo(0.325, 10);
  });
});

describe('factors', () => {
  it('applies Recommended Bolus % and rounds down to the pump increment', () => {
    const r = calc();
    expect(r.factoredInsulin).toBeCloseTo(0.2275, 10);
    expect(r.insulinCalculated).toBe(0.2);
  });

  it('does not scale a negative bolus', () => {
    const r = calc({ iob: 2 });
    expect(r.factoredInsulin).toBeCloseTo(r.wholeCalc, 10);
    expect(r.insulinCalculated).toBe(0);
  });

  it('fatty meal multiplies by the Reduced Bolus %', () => {
    const r = calc({ carbs: 60, carbRatio: 10, useFattyMealCorrectionFactor: true, fattyMealFactor: 0.5 });
    expect(r.factoredInsulin).toBeCloseTo((0.245 + 6 + 0.08) * 0.7 * 0.5, 10);
    expect(r.insulinCalculated).toBe(2.2);
  });

  it('super bolus adds sweet meal factor × basal after the percentage', () => {
    const r = calc({ carbs: 30, carbRatio: 10, useSuperBolus: true, sweetMealFactor: 1, basal: 0.8 });
    expect(r.superBolusInsulin).toBeCloseTo(0.8, 10);
    expect(r.factoredInsulin).toBeCloseTo((0.245 + 3 + 0.08) * 0.7 + 0.8, 10);
  });

  it('super bolus is added even when the full bolus is negative', () => {
    const r = calc({ iob: 1, useSuperBolus: true, basal: 1 });
    expect(r.factoredInsulin).toBeCloseTo(0.325 - 1 + 1, 10);
  });
});

describe('guards and limits', () => {
  it('no recommendation when glucose is below 54', () => {
    expect(calc({ currentBG: 50, carbs: 60 }).insulinCalculated).toBe(0);
  });
  it('no recommendation when the forecast minimum is below 54', () => {
    expect(calc({ minPredBG: 53, carbs: 60 }).insulinCalculated).toBe(0);
  });
  it('no recommendation when the last loop is older than 15 minutes or missing', () => {
    expect(calc({ lastLoopDate: NOW - 16 * MIN, carbs: 60 }).insulinCalculated).toBe(0);
    expect(calc({ lastLoopDate: null, carbs: 60 }).insulinCalculated).toBe(0);
  });
  it('is limited by Max Bolus', () => {
    expect(calc({ carbs: 120, carbRatio: 5, maxIOB: 50 }).insulinCalculated).toBe(10);
  });
  it('is limited by Max IOB − IOB', () => {
    expect(calc({ carbs: 60, carbRatio: 5, iob: 1, maxIOB: 3 }).insulinCalculated).toBe(2);
  });
});

describe('rounding', () => {
  it('rounds down to the increment', () => {
    expect(roundBolus(1.29, 0.05, 10)).toBe(1.25);
    expect(roundBolus(0.3, 0.1, 10)).toBe(0.3);
    expect(roundBolus(0.2275, 0.025, 10)).toBe(0.225);
  });
  it('never exceeds the rounded Max Bolus', () => {
    expect(roundBolus(12, 0.05, 10)).toBe(10);
  });
  it('without a pump the amount is unchanged', () => {
    expect(roundBolus(1.234, null, 10)).toBe(1.234);
  });
  it('never returns a negative amount', () => {
    expect(roundBolus(-0.5, 0.05, 10)).toBe(0);
  });
});

describe('inputs', () => {
  it('delta: newest − oldest reading within 20 minutes', () => {
    const g = [
      { date: NOW - 25 * MIN, value: 100 },
      { date: NOW - 15 * MIN, value: 143 },
      { date: NOW - 10 * MIN, value: 150 },
      { date: NOW, value: 159 },
    ];
    expect(glucoseDelta(g, NOW)).toBe(16);
    expect(glucoseDelta([{ date: NOW, value: 159 }], NOW)).toBe(0);
  });
  it('backdated means more than one second away from the opening time', () => {
    expect(isBackdated(NOW + 500, NOW)).toBe(false);
    expect(isBackdated(NOW - 15 * MIN, NOW)).toBe(true);
  });
  it('algorithm suggestion: insulinReq × % capped at Max Bolus', () => {
    expect(algorithmSuggestedBolus(0.4686, 0.7, 10)).toBeCloseTo(0.328, 3);
    expect(algorithmSuggestedBolus(-1, 0.7, 10)).toBe(0);
    expect(algorithmSuggestedBolus(20, 0.7, 10)).toBe(10);
  });
  it('parses either decimal separator', () => {
    expect(parseDecimal('1,25')).toBe(1.25);
    expect(parseDecimal('')).toBe(0);
  });
});

describe('fat-protein units', () => {
  it('converts kcal / 10 × factor, floored', () => {
    expect(carbEquivalentGrams(20, 30, 0.5)).toBe(15);
    expect(carbEquivalentGrams(25, 10, 0.5)).toBe(13);
  });
  it('caps at 99 g', () => {
    expect(carbEquivalentGrams(200, 200, 1.2)).toBe(99);
  });
  it('splits evenly into at most 3 entries of 10–33 g', () => {
    expect(splitIntoCarbEquivalents(9)).toEqual([]);
    expect(splitIntoCarbEquivalents(15)).toEqual([15]);
    expect(splitIntoCarbEquivalents(34)).toEqual([17, 17]);
    expect(splitIntoCarbEquivalents(67)).toEqual([23, 22, 22]);
    expect(splitIntoCarbEquivalents(99)).toEqual([33, 33, 33]);
  });
  it('schedules after the delay, one per spread interval', () => {
    const e = fpuCarbEquivalents(40, 40, NOW, { individualAdjustmentFactor: 0.5, delay: 60, minuteInterval: 30 });
    // (40×9 + 40×4) / 10 × 0.5 = 26 → one entry
    expect(e).toEqual([{ date: NOW + 60 * MIN, grams: 26 }]);
    const big = fpuCarbEquivalents(60, 60, NOW, { individualAdjustmentFactor: 0.5, delay: 60, minuteInterval: 30 });
    expect(big).toEqual([
      { date: NOW + 60 * MIN, grams: 20 },
      { date: NOW + 90 * MIN, grams: 19 },
    ]);
  });
  it('drops equivalents below 10 g', () => {
    expect(fpuCarbEquivalents(5, 5, NOW, { individualAdjustmentFactor: 0.5, delay: 60, minuteInterval: 30 })).toEqual([]);
  });
  it('clamps settings to Trio ranges', () => {
    const e = fpuCarbEquivalents(40, 40, NOW, { individualAdjustmentFactor: 0.5, delay: 5, minuteInterval: 30 });
    expect(e[0]!.date).toBe(NOW + 15 * MIN);
  });
});

describe('view logic', () => {
  const s: TreatmentButtonState = { amount: 0, carbs: 0, fat: 0, protein: 0, externalInsulin: false, maxBolus: 10, maxCarbs: 250, maxFat: 250, maxProtein: 250 };
  it('button labels', () => {
    expect(treatmentButtonLabel(s)).toBe('Continue Without Treatment');
    expect(treatmentButtonLabel({ ...s, carbs: 30 })).toBe('Log Carbs');
    expect(treatmentButtonLabel({ ...s, carbs: 30, amount: 2 })).toBe('Log Carbs and Enact Bolus');
    expect(treatmentButtonLabel({ ...s, carbs: 30, amount: 2, externalInsulin: true })).toBe('Log Carbs and External Insulin');
    expect(treatmentButtonLabel({ ...s, amount: 2, externalInsulin: true })).toBe('Log External Insulin');
    expect(treatmentButtonLabel({ ...s, fat: 10, carbs: 20 })).toBe('Log Meal');
    expect(treatmentButtonLabel({ ...s, protein: 10 })).toBe('Log FPU');
    expect(treatmentButtonLabel({ ...s, protein: 10, amount: 1 })).toBe('Log FPU and Enact Bolus');
  });
  it('limit labels', () => {
    expect(limitExceededLabel({ ...s, amount: 11 }, 'en')).toBe('Max Bolus of 10 U Exceeded');
    expect(limitExceededLabel({ ...s, amount: 11, externalInsulin: true }, 'en')).toBeNull();
    expect(limitExceededLabel({ ...s, amount: 31, externalInsulin: true }, 'en')).toBe('Max External Bolus of 30 U Exceeded');
    expect(limitExceededLabel({ ...s, carbs: 251 }, 'en')).toBe('Max Carbs of 250 g Exceeded');
  });
  it('bolus warnings', () => {
    expect(bolusWarning({ externalInsulin: false, amount: 1, currentBG: 50, minPredBG: 100, confirmBolus: true })).toEqual({ shouldConfirm: true, message: 'Glucose is very low.', tone: 'red' });
    expect(bolusWarning({ externalInsulin: false, amount: 1, currentBG: 100, minPredBG: 40, confirmBolus: false }).message).toBe('Glucose forecast is very low.');
    expect(bolusWarning({ externalInsulin: true, amount: 1, currentBG: 40, minPredBG: 40, confirmBolus: true }).message).toBe('');
  });
  it('progress text', () => {
    expect(progressText(1, 10)).toBe('Updating IOB and COB ...');
    expect(progressText(0, 0)).toBe('Updating Treatments ...');
  });
  it('insulin formatter rounds down and wraps negatives', () => {
    expect(insulinFormatter(0.2275, 'down', false, 'en')).toBe('0.22');
    expect(insulinFormatter(0.2, 'down', true, 'en')).toBe('0.20');
    expect(wrapNegative(-1.235, 'down', 'en')).toBe('(-1.24)');
    expect(wrapNegative(-1.235, 'plain', 'en')).toBe('(-1.24)');
    expect(insulinFormatter(0.24, 'down', false, 'de')).toBe('0,24');
    expect(formatGlucoseDelta(16, 'mg/dL', 'en')).toBe('+16');
  });
  it('recommendation card warnings and rounding note', () => {
    const r = { insulinCalculated: 0.2, factoredInsulin: 0.2275, iob: 0, maxIOB: 6, maxBolus: 10, currentBG: 159, minPredBG: 120, lastLoopDate: NOW, now: NOW };
    expect(recommendationWarning(r)).toBeNull();
    expect(isRoundedForPump(r)).toBe(true);
    expect(recommendationWarning({ ...r, lastLoopDate: null })).toEqual({ kind: 'stale' });
    expect(recommendationWarning({ ...r, factoredInsulin: 4, iob: 3, maxIOB: 6 })).toEqual({ kind: 'maxIob', available: 3 });
    expect(recommendationWarning({ ...r, factoredInsulin: 12, maxIOB: 20 })).toEqual({ kind: 'maxBolus' });
  });
});
