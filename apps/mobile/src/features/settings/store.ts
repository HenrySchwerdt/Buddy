import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Trio settings that have no home in Buddy's core settings store (TrioSettings defaults
 * from Trio dev). Meal / bolus-calculator fields and maxCOB live in the Treatments
 * feature's store (`useTreatmentSettings`); everything here is read via `useTrioPrefs`.
 * Values marked "display only" do not influence dosing anywhere in Buddy.
 */
export interface TrioPrefs {
  readonly enableQuickPickTreatments: boolean;
  // Meal Settings (not in the Treatments store)
  readonly maxMealAbsorptionTime: number;
  // Shortcuts / Remote Control
  readonly allowBolusByShortcuts: boolean;
  readonly isTrioRemoteControlEnabled: boolean;
  // User Interface (display only)
  readonly glucoseColorScheme: 'dynamicColor' | 'staticColor';
  readonly xGridLines: boolean;
  readonly yGridLines: boolean;
  readonly rulerMarks: boolean;
  readonly low: number;
  readonly high: number;
  readonly forecastDisplayType: 'cone' | 'lines';
  readonly bolusDisplayThreshold: number;
  readonly eA1cDisplayUnit: 'percent' | 'mmolMol';
  readonly timeInRangeType: 'timeInTightRange' | 'timeInNormoglycemia';
  readonly homeStatsPanelFace: 'timeInRange' | 'distributionBar' | 'averages' | 'hidden';
  readonly homeStatsPanelRange: 'today' | 'day' | 'week' | 'month' | 'threeMonths';
  readonly showCarbsRequiredBadge: boolean;
  readonly carbsRequiredThreshold: number;
  readonly requireAdjustmentsConfirmation: boolean;
}

export const DEFAULT_TRIO_PREFS: TrioPrefs = {
  enableQuickPickTreatments: false,
  maxMealAbsorptionTime: 6,
  allowBolusByShortcuts: false,
  isTrioRemoteControlEnabled: false,
  glucoseColorScheme: 'dynamicColor',
  xGridLines: true,
  yGridLines: true,
  rulerMarks: true,
  low: 70,
  high: 180,
  forecastDisplayType: 'cone',
  bolusDisplayThreshold: 0.01,
  eA1cDisplayUnit: 'percent',
  timeInRangeType: 'timeInTightRange',
  homeStatsPanelFace: 'timeInRange',
  homeStatsPanelRange: 'today',
  showCarbsRequiredBadge: true,
  carbsRequiredThreshold: 10,
  requireAdjustmentsConfirmation: false,
};

interface Actions {
  set(patch: Partial<TrioPrefs>): void;
}

export const useTrioPrefs = create<TrioPrefs & Actions>()(
  persist(
    (set) => ({
      ...DEFAULT_TRIO_PREFS,
      set: (patch) => set((s) => ({ ...s, ...patch })),
    }),
    {
      name: 'buddy.settings-a.v1',
      version: 1,
      storage: createJSONStorage(() => Storage),
      migrate: (persisted) => ({ ...DEFAULT_TRIO_PREFS, ...(persisted as Partial<TrioPrefs>) }),
      partialize: ({ set: _s, ...rest }) => rest,
    },
  ),
);

export type TrioPrefKey = keyof TrioPrefs;
