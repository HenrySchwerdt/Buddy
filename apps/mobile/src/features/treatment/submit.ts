import { newId } from '@buddy/core';
import { deliverBolus, logCarbs, now, runLoop, store } from '@/runtime/runtime';
import { maxExternal } from './formatting';
import { fpuCarbEquivalents, type FpuSettings } from './fpu';
import { STALE_GLUCOSE_MS } from './use-treatment-model';

export interface TreatmentRequest {
  readonly carbs: number;
  readonly fat: number;
  readonly protein: number;
  readonly amount: number;
  readonly externalInsulin: boolean;
  readonly date: number;
  readonly backdated: boolean;
  readonly maxBolus: number;
  readonly maxCarbs: number;
  readonly maxFat: number;
  readonly maxProtein: number;
  readonly fpu: FpuSettings;
}

export type TreatmentOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Trio's `saveMeal`: the carb entry at the treatment time plus FPU carb equivalents.
 * Buddy has no fat/protein fields on carb entries, so only the equivalents are stored.
 */
async function saveMeal(r: TreatmentRequest): Promise<void> {
  const carbs = Math.min(r.carbs, r.maxCarbs);
  const fat = Math.min(r.fat, r.maxFat);
  const protein = Math.min(r.protein, r.maxProtein);
  if (carbs > 0) {
    // logCarbs stamps "now" and feeds the demo simulator; a backdated entry is written directly.
    if (r.backdated) store.addCarbs({ id: newId('carbs'), date: r.date, grams: carbs });
    else await logCarbs(carbs);
  }
  for (const e of fpuCarbEquivalents(fat, protein, r.date, r.fpu)) {
    store.addCarbs({ id: newId('fpu'), date: e.date, grams: e.grams });
  }
}

/** Records insulin given outside the pump (pen, syringe). The pump is never commanded. */
function addExternalInsulin(r: TreatmentRequest): void {
  const units = Math.min(r.amount, maxExternal(r.maxBolus));
  store.addDoses([{ kind: 'bolus', date: r.date, units, id: newId('ext') }]);
}

/** `invokeTreatmentsTask`: meal first, then insulin, then a loop run to update IOB/COB. */
export async function invokeTreatments(r: TreatmentRequest): Promise<TreatmentOutcome> {
  try {
    if (r.carbs > 0 || r.fat > 0 || r.protein > 0) await saveMeal(r);
    if (r.amount > 0) {
      if (r.externalInsulin) addExternalInsulin(r);
      else await deliverBolus(Math.min(r.amount, r.maxBolus));
    }
    await runLoop();
    if (r.amount > 0) {
      const last = store.snapshot().glucose.at(-1)?.date ?? null;
      if (last == null || last <= now() - STALE_GLUCOSE_MS) return { ok: false, message: 'Glucose data is stale' };
    }
    return { ok: true };
  } catch (e) {
    console.warn(`[buddy] Treatment failed: ${errorMessage(e)}`);
    return { ok: false, message: errorMessage(e) };
  }
}
