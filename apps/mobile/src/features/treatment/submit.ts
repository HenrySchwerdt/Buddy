import { newId } from '@buddy/core';
import { deliverBolus, logCarbs, now, runLoop, store, useRuntime } from '@/runtime/runtime';
import { requireUnlock } from '@/runtime/unlock';
import { maxExternal } from './formatting';
import { fpuCarbEquivalents, type FpuSettings } from './fpu';
import { STALE_GLUCOSE_MS } from './use-treatment-model';

export interface TreatmentRequest {
  readonly carbs: number;
  readonly fat: number;
  readonly protein: number;
  readonly amount: number;
  /** Free-text note stored with the carb entry (Trio's `state.note`). */
  readonly note: string;
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
 * Trio's `saveMeal`: the carb entry at the treatment time (with the note) plus FPU carb equivalents.
 * Buddy has no fat/protein fields on carb entries, so only the equivalents are stored; like in Trio
 * the equivalents do not carry the note.
 */
async function saveMeal(r: TreatmentRequest): Promise<void> {
  const carbs = Math.min(r.carbs, r.maxCarbs);
  const fat = Math.min(r.fat, r.maxFat);
  const protein = Math.min(r.protein, r.maxProtein);
  const note = r.note.trim();
  if (carbs > 0) {
    // logCarbs stamps "now" and feeds the demo simulator; a backdated entry is written directly.
    if (r.backdated) store.addCarbs({ id: newId('carbs'), date: r.date, grams: carbs, ...(note ? { note } : {}) });
    else await logCarbs(carbs, undefined, note || undefined);
  }
  for (const e of fpuCarbEquivalents(fat, protein, r.date, r.fpu)) {
    store.addCarbs({ id: newId('fpu'), date: e.date, grams: e.grams });
  }
}

/**
 * Trio's `storeExternalInsulinEvent`: insulin given outside the pump (pen, syringe) is stored as an
 * external bolus, never later than now. It reaches the dose store only: the pump is never commanded.
 */
function addExternalInsulin(r: TreatmentRequest): void {
  store.addDoses([{ kind: 'bolus', date: Math.min(r.date, now()), units: r.amount, id: newId('external'), external: true }]);
}

/**
 * Rejects an external dose before anything is stored. Trio blocks the button above 3× Max Bolus;
 * capping instead would record less insulin than was injected and understate IOB.
 */
function externalInsulinError(r: TreatmentRequest): string | null {
  if (!Number.isFinite(r.amount) || !Number.isFinite(r.date)) return 'Invalid external insulin entry';
  if (r.amount > maxExternal(r.maxBolus)) return `External insulin is limited to ${maxExternal(r.maxBolus)} U`;
  return null;
}

/** `invokeTreatmentsTask`: meal first, then insulin, then a loop run to update IOB/COB. */
export async function invokeTreatments(r: TreatmentRequest): Promise<TreatmentOutcome> {
  const external = r.amount > 0 && r.externalInsulin;
  if (external || (r.externalInsulin && !Number.isFinite(r.amount))) {
    const invalid = externalInsulinError(r);
    if (invalid) return { ok: false, message: invalid };
  }
  let recorded = false;
  try {
    // Trio UnlockManager: a pump bolus needs the owner's biometrics or passcode, before anything is stored.
    // The demo world has no real pump, so it skips the prompt.
    if (r.amount > 0 && !r.externalInsulin && !useRuntime.getState().demo) await requireUnlock();
    if (r.carbs > 0 || r.fat > 0 || r.protein > 0) await saveMeal(r);
    if (r.amount > 0) {
      if (r.externalInsulin) {
        addExternalInsulin(r);
        recorded = true;
      } else await deliverBolus(Math.min(r.amount, r.maxBolus));
    }
    await runLoop();
    // Stale glucose matters for a pump bolus decision, not for logging insulin already injected.
    if (r.amount > 0 && !external) {
      const last = store.snapshot().glucose.at(-1)?.date ?? null;
      if (last == null || last <= now() - STALE_GLUCOSE_MS) return { ok: false, message: 'Glucose data is stale' };
    }
    return { ok: true };
  } catch (e) {
    console.warn(`[buddy] Treatment failed: ${errorMessage(e)}`);
    // Never let the user believe an already stored external dose was lost: they would log it twice.
    if (recorded) return { ok: false, message: `External insulin was recorded, but updating the loop failed: ${errorMessage(e)}` };
    return { ok: false, message: errorMessage(e) };
  }
}
