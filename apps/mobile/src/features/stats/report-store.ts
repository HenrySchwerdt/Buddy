import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Interval } from './calc';
import type { ReportChartType } from './pdf-report';

/** ReportPreset: a named range and chart selection. */
export interface ReportPreset {
  readonly id: string;
  readonly name: string;
  readonly range: Interval;
  readonly charts: readonly ReportChartType[];
}

interface State {
  readonly patientName: string;
  readonly presets: readonly ReportPreset[];
  setPatientName(name: string): void;
  savePreset(preset: Omit<ReportPreset, 'id'>): void;
  deletePreset(id: string): void;
}

/** Saved report presets and the last patient name (loadReportPresets / loadReportPatientName). */
export const useReportStore = create<State>()(
  persist(
    (set) => ({
      patientName: '',
      presets: [],
      setPatientName: (patientName) => set({ patientName: patientName.trim() }),
      savePreset: (p) => set((s) => ({ presets: [...s.presets, { ...p, id: `${Date.now()}-${s.presets.length}` }] })),
      deletePreset: (id) => set((s) => ({ presets: s.presets.filter((p) => p.id !== id) })),
    }),
    { name: 'buddy.stats.report.v1', version: 1, storage: createJSONStorage(() => Storage), partialize: (s) => ({ patientName: s.patientName, presets: s.presets }) },
  ),
);
