import { create } from 'zustand';
import type { AlgorithmDecision } from '@buddy/core';

/**
 * Transient form state of the open Treatments sheet (Trio's `Treatments.StateModel` fields).
 * Shared with the Bolus Calculator Details and Meal Presets sheets, which are separate routes.
 * Not persisted: every opening of the sheet starts fresh, like Trio.
 */
export interface TreatmentDraft {
  readonly carbs: string;
  readonly fat: string;
  readonly protein: string;
  readonly amount: string;
  readonly note: string;
  /** Treatment time (epoch ms). */
  readonly date: number;
  /** Time the sheet opened; `date` differing by > 1 s means backdated. */
  readonly defaultDate: number;
  /** Time row expanded from "Now" to the picker. */
  readonly timePushed: boolean;
  readonly externalInsulin: boolean;
  readonly useFattyMealCorrectionFactor: boolean;
  readonly useSuperBolus: boolean;
  /** Algorithm run with the entered carbs/bolus (Trio's `simulatedDetermination`). */
  readonly simulated: AlgorithmDecision | null;
}

interface Actions {
  reset(now: number): void;
  set(patch: Partial<TreatmentDraft>): void;
  /** Adds preset macros to the entered amounts ("Add to Treatments"). */
  addMacros(carbs: number, fat: number, protein: number): void;
}

const blank = (now: number): TreatmentDraft => ({
  carbs: '',
  fat: '',
  protein: '',
  amount: '',
  note: '',
  date: now,
  defaultDate: now,
  timePushed: false,
  externalInsulin: false,
  useFattyMealCorrectionFactor: false,
  useSuperBolus: false,
  simulated: null,
});

const toText = (n: number) => (n > 0 ? String(Math.round(n)) : '');
const toNum = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const useTreatmentDraft = create<TreatmentDraft & Actions>()((set) => ({
  ...blank(0),
  reset: (now) => set(blank(now)),
  set: (patch) => set((s) => ({ ...s, ...patch })),
  addMacros: (carbs, fat, protein) =>
    set((s) => ({
      ...s,
      carbs: toText(toNum(s.carbs) + carbs),
      fat: toText(toNum(s.fat) + fat),
      protein: toText(toNum(s.protein) + protein),
    })),
}));
