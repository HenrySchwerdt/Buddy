import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import Storage from 'expo-sqlite/kv-store';
import { DEFAULT_MAX_COB } from './calculator';
import { FPU_RANGES } from './fpu';

/**
 * Trio settings the Treatments sheet reads that Buddy's settings-store does not have
 * (TrioSettings meal / bolus-calculator fields and Preferences.maxCOB), with Trio defaults.
 * Settings screens (Meal Settings, Bolus Calculator) can bind to this store.
 */
export interface TreatmentSettings {
  /** Meal Settings → "Enable Fat and Protein Entries" */
  readonly useFPUconversion: boolean;
  readonly individualAdjustmentFactor: number;
  /** minutes */
  readonly delay: number;
  /** minutes */
  readonly minuteInterval: number;
  readonly maxCarbs: number;
  readonly maxFat: number;
  readonly maxProtein: number;
  /** Bolus Calculator → "Fatty Meals" (Reduced Bolus) */
  readonly fattyMeals: boolean;
  readonly fattyMealFactor: number;
  /** Bolus Calculator → "Super Bolus" */
  readonly sweetMeals: boolean;
  readonly sweetMealFactor: number;
  /** Bolus Calculator → "Display Meal Presets" */
  readonly displayPresets: boolean;
  /** Bolus Calculator → "Very Low Glucose Warning" confirmation */
  readonly confirmBolus: boolean;
  /** oref preference maxCOB, g */
  readonly maxCOB: number;
}

export const DEFAULT_TREATMENT_SETTINGS: TreatmentSettings = {
  useFPUconversion: false,
  individualAdjustmentFactor: FPU_RANGES.individualAdjustmentFactor.default,
  delay: FPU_RANGES.delay.default,
  minuteInterval: FPU_RANGES.minuteInterval.default,
  maxCarbs: 250,
  maxFat: 250,
  maxProtein: 250,
  fattyMeals: false,
  fattyMealFactor: 0.7,
  sweetMeals: false,
  sweetMealFactor: 1,
  displayPresets: true,
  confirmBolus: false,
  maxCOB: DEFAULT_MAX_COB,
};

interface Actions {
  update(patch: Partial<TreatmentSettings>): void;
}

export const useTreatmentSettings = create<TreatmentSettings & Actions>()(
  persist(
    (set) => ({
      ...DEFAULT_TREATMENT_SETTINGS,
      update: (patch) => set((s) => ({ ...s, ...patch })),
    }),
    {
      name: 'buddy.treatment.v1',
      version: 1,
      storage: createJSONStorage(() => Storage),
      partialize: ({ update: _u, ...rest }) => rest,
    },
  ),
);
