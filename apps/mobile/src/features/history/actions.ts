import { create } from 'zustand';
import type { CarbEntry, GlucoseReading } from '@buddy/core';
import { now, store } from '@/runtime/runtime';
import { MANUAL_SOURCE, glucoseKey, type HistoryMode } from './rows';

export { manualGlucoseMgdl, parseGlucoseInput } from './validation';

/** Selected History segment; Add Glucose switches it to Glucose after saving (Trio). */
export const useHistoryMode = create<{ mode: HistoryMode; setMode: (m: HistoryMode) => void }>()((set) => ({
  mode: 'treatments',
  setMode: (mode) => set({ mode }),
}));

/** Adds a fingerstick reading (always stored in mg/dL, like Trio's addManualGlucose). */
export function addManualGlucose(mgdl: number): void {
  store.addGlucose([{ date: now(), value: mgdl, source: MANUAL_SOURCE }]);
}

/** Removes one glucose reading. */
export function deleteGlucose(reading: GlucoseReading): void {
  store.removeGlucose(reading.source, reading.date);
}

export function deleteCarbs(entry: CarbEntry): void {
  store.removeCarbs(entry.id);
}

/**
 * Edit Meal: same id, new amount, date and note. Without `note` the stored note is kept;
 * a blank note removes it (Trio's `newNote`).
 */
export function updateCarbs(entry: CarbEntry, grams: number, date: number, note?: string): void {
  const { note: previous, ...rest } = entry;
  const next = (note === undefined ? previous : note.trim()) || undefined;
  store.removeCarbs(entry.id);
  store.addCarbs({ ...rest, grams, date, ...(next ? { note: next } : {}) });
}
