import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import Storage from 'expo-sqlite/kv-store';
import { newId } from '@buddy/core';

/** Trio's `MealPresetStored`. */
export interface MealPreset {
  readonly id: string;
  readonly dish: string;
  readonly carbs: number;
  readonly fat: number;
  readonly protein: number;
}

interface PresetsState {
  readonly presets: readonly MealPreset[];
  add(p: Omit<MealPreset, 'id'>): void;
  remove(id: string): void;
}

/** Presets sorted by dish like Trio's fetch request (`dish` ascending). */
export const sortedPresets = (presets: readonly MealPreset[]) => [...presets].sort((a, b) => (a.dish < b.dish ? -1 : a.dish > b.dish ? 1 : 0));

export const useMealPresets = create<PresetsState>()(
  persist(
    (set) => ({
      presets: [],
      add: (p) => set((s) => ({ presets: [...s.presets, { ...p, id: newId('preset') }] })),
      remove: (id) => set((s) => ({ presets: s.presets.filter((p) => p.id !== id) })),
    }),
    {
      name: 'buddy.treatment-presets.v1',
      version: 1,
      storage: createJSONStorage(() => Storage),
      partialize: ({ presets }) => ({ presets }),
    },
  ),
);
