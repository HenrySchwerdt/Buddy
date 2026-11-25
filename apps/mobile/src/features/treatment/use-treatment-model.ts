import { useMemo } from 'react';
import { carbsOnBoard, effectiveSettings, isTempTargetActive, scheduleValueAt, HOUR, MINUTE, type AlgorithmDecision, type LoopRun, type Predictions } from '@buddy/core';
import { useLiveState, useSnapshot } from '@/runtime/hooks';
import { useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { algorithmSuggestedBolus, calculateInsulin, glucoseDelta, isBackdated, type CalculationInput, type CalculationResult } from './calculator';
import { useTreatmentDraft, type TreatmentDraft } from './draft-store';
import { lowestPrediction } from './forecast';
import { parseDecimal } from './formatting';
import { useTreatmentSettings, type TreatmentSettings } from './settings-store';

/** Trio's `predicateFor30MinAgoForDetermination`. */
const DETERMINATION_MAX_AGE = 30 * MINUTE;

export interface TreatmentModel {
  readonly draft: TreatmentDraft;
  readonly settings: TreatmentSettings;
  readonly carbs: number;
  readonly fat: number;
  readonly protein: number;
  readonly amount: number;
  readonly backdated: boolean;
  readonly input: CalculationInput;
  /** Min predicted BG of the forecast including the entered bolus (drives the low-forecast warning). */
  readonly forecastMinPredBG: number;
  readonly result: CalculationResult;
  /** COB shown in the details sheet (simulated when backdated). */
  readonly displayedCob: number;
  readonly determination: LoopRun | null;
  /** Simulation if any, otherwise the latest determination. */
  readonly forecast: Predictions | undefined;
  readonly eventualBG: number | null;
  readonly algorithmSuggested: number;
  readonly loopMode: 'open' | 'closed';
  readonly maxBolus: number;
  readonly maxIOB: number;
  readonly fraction: number;
  readonly units: 'mg/dL' | 'mmol/L';
  readonly latestGlucoseDate: number | null;
  readonly now: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** Latest successful loop run of the last 30 minutes (Trio's determination fetch). */
function latestDetermination(runs: readonly LoopRun[], now: number): LoopRun | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (r.date < now - DETERMINATION_MAX_AGE) return null;
    if (!r.error && r.suggested) return r;
  }
  return null;
}

function minPredicted(decision: AlgorithmDecision | null | undefined, currentBG: number): number | undefined {
  if (!decision) return undefined;
  const fromOref = decision.debug?.minPredBG;
  if (typeof fromOref === 'number' && fromOref > 0) return fromOref;
  return lowestPrediction(decision.predictions) ?? decision.eventualGlucose ?? currentBG;
}

/**
 * Everything the Treatments sheet and the Bolus Calculator Details sheet show, derived from
 * the draft, live data and settings (Trio's `Treatments.StateModel`).
 */
export function useTreatmentModel(): TreatmentModel {
  const draft = useTreatmentDraft();
  const snap = useSnapshot();
  const live = useLiveState();
  const pump = useRuntime((s) => s.pump);
  const { profile, limits, bolusFraction, units, override, tempTarget, loopMode } = useSettings();
  const ts = useTreatmentSettings();

  return useMemo(() => {
    const now = live.now;
    const carbs = Math.round(parseDecimal(draft.carbs));
    const fat = Math.round(parseDecimal(draft.fat));
    const protein = Math.round(parseDecimal(draft.protein));
    const amount = parseDecimal(draft.amount);
    const backdated = isBackdated(draft.date, draft.defaultDate);

    const determination = latestDetermination(snap.loopRuns, now);
    const lastLoop = [...snap.loopRuns].reverse().find((r) => !r.error) ?? null;
    const debug = determination?.suggested?.debug;
    const tt = tempTarget && isTempTargetActive(tempTarget, now) ? { low: tempTarget.target, high: tempTarget.target } : null;
    const eff = effectiveSettings(profile, now, override, tt);
    const last = snap.glucose.at(-1) ?? null;
    const currentBG = last?.value ?? 0;

    // Backdated: carbs count through COB instead (Trio sets the entered carbs to 0).
    const liveCob = Math.trunc(live.cob);
    const simulatedCob = backdated && carbs > 0 ? Math.min(ts.maxCOB, Math.trunc(carbsOnBoard([...snap.carbs, { id: 'sim', date: draft.date, grams: carbs }], now))) : liveCob;
    const displayedCob = backdated ? simulatedCob : liveCob;

    const latestMinPred = minPredicted(determination?.suggested, currentBG);
    // Recommendation: forecast without the entered bolus (Trio). Warning: forecast including it.
    const minPred = minPredicted(draft.simulatedForCalc, currentBG) ?? latestMinPred ?? 0;
    const forecastMinPred = minPredicted(draft.simulated, currentBG) ?? latestMinPred ?? 0;

    const input: CalculationInput = {
      carbs: backdated ? 0 : carbs,
      currentBG,
      deltaBG: glucoseDelta(snap.glucose.slice(-12), now),
      target: num(debug?.target) ?? eff.target.low,
      isf: num(debug?.ISF) ?? eff.isf,
      carbRatio: num(debug?.CR) ?? eff.carbRatio,
      iob: live.iob.iob,
      cob: displayedCob,
      useFattyMealCorrectionFactor: draft.useFattyMealCorrectionFactor,
      fattyMealFactor: ts.fattyMealFactor,
      useSuperBolus: draft.useSuperBolus,
      sweetMealFactor: ts.sweetMealFactor,
      basal: scheduleValueAt(profile.basal, now, profile.utcOffsetMinutes),
      fraction: bolusFraction,
      maxBolus: limits.maxBolus,
      maxIOB: limits.maxIOB,
      maxCOB: ts.maxCOB,
      minPredBG: minPred,
      lastLoopDate: lastLoop?.date ?? null,
      now,
      bolusIncrement: pump?.bolusIncrement ?? null,
    };
    const result = calculateInsulin(input);
    const forecast = draft.simulated?.predictions ?? determination?.suggested?.predictions;
    const eventualBG = draft.simulated?.eventualGlucose ?? determination?.suggested?.eventualGlucose ?? null;

    return {
      draft,
      settings: ts,
      carbs,
      fat,
      protein,
      amount,
      forecastMinPredBG: forecastMinPred,
      backdated,
      input,
      result,
      displayedCob,
      determination,
      forecast,
      eventualBG,
      algorithmSuggested: algorithmSuggestedBolus(determination?.suggested?.insulinReq, bolusFraction, limits.maxBolus),
      loopMode,
      maxBolus: limits.maxBolus,
      maxIOB: limits.maxIOB,
      fraction: bolusFraction,
      units,
      latestGlucoseDate: last?.date ?? null,
      now,
    };
  }, [draft, snap, live, pump, profile, limits, bolusFraction, units, override, tempTarget, loopMode, ts]);
}

export const STALE_GLUCOSE_MS = 6 * MINUTE;
export const CHART_HOURS_BACK = 4 * HOUR;
