import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  DEFAULT_DRAFT,
  INITIAL_VALUES,
  PICKERS,
  basalPicker,
  newItem,
  pickerValues,
  pumpModel,
  snapItems,
  suggestedMaxIOB,
  totalDailyBasal,
  type OnboardingDraft,
  type TherapyItem,
} from './logic';
import type { NightscoutImportOption, NightscoutSetupOption } from './model';

export type ScheduleKey = 'targets' | 'basal' | 'carbRatios' | 'isf';

/** Value grid of a schedule for the current units / pump model. */
export function scheduleOptions(key: ScheduleKey, d: Pick<OnboardingDraft, 'units' | 'pumpModelId'>): number[] {
  switch (key) {
    case 'targets':
      return pickerValues(PICKERS.target, d.units);
    case 'isf':
      return pickerValues(PICKERS.isf, d.units);
    case 'carbRatios':
      return pickerValues(PICKERS.carbRatio, d.units);
    case 'basal':
      return pickerValues(basalPicker(pumpModel(d.pumpModelId)), d.units);
  }
}

export interface NightscoutDraft {
  readonly setup: NightscoutSetupOption;
  readonly importOption: NightscoutImportOption;
  readonly url: string;
  readonly token: string;
  readonly responseMessage: string;
  readonly connecting: boolean;
  readonly connected: boolean;
  readonly uploadEnabled: boolean;
  readonly uploadGlucose: boolean;
  readonly uploadCGMSensorStates: boolean;
  readonly importStatus: 'none' | 'running' | 'finished' | 'failed';
}

const DEFAULT_NIGHTSCOUT: NightscoutDraft = {
  setup: null,
  importOption: null,
  url: '',
  token: '',
  responseMessage: '',
  connecting: false,
  connected: false,
  uploadEnabled: true,
  uploadGlucose: true,
  uploadCGMSensorStates: true,
  importStatus: 'none',
};

interface DraftState extends OnboardingDraft {
  readonly acknowledged: boolean;
  readonly nightscout: NightscoutDraft;
  set(patch: Partial<OnboardingDraft & { acknowledged: boolean }>): void;
  setNightscout(patch: Partial<NightscoutDraft>): void;
  setSchedule(key: ScheduleKey, items: readonly TherapyItem[]): void;
  /** Seeds a schedule with Trio's initial entry when it is still empty (`addInitialX`). */
  seedSchedule(key: ScheduleKey): void;
  setUnits(units: OnboardingDraft['units']): void;
  setPumpModel(id: string): void;
  /** `seedMaxIOBIfUnset()` — a third of the total daily basal. */
  seedMaxIOB(): void;
}

/**
 * In-memory onboarding draft (Trio's StateModel). Like Trio it is not persisted: progress is
 * written to the app settings only when the user taps "Get Started".
 */
export const useOnboardingDraft = create<DraftState>()((set, get) => ({
  ...DEFAULT_DRAFT,
  acknowledged: false,
  nightscout: DEFAULT_NIGHTSCOUT,
  set: (patch) => set(patch),
  setNightscout: (patch) => set((s) => ({ nightscout: { ...s.nightscout, ...patch } })),
  setSchedule: (key, items) => set((s) => ({ [key]: snapItems(items, scheduleOptions(key, s)) })),
  seedSchedule: (key) => {
    const s = get();
    if (s[key].length > 0) return;
    set({ [key]: snapItems([newItem(0, INITIAL_VALUES[key])], scheduleOptions(key, s)) });
  },
  setUnits: (units) =>
    set((s) => {
      const next = { ...s, units };
      return { units, targets: snapItems(s.targets, scheduleOptions('targets', next)), isf: snapItems(s.isf, scheduleOptions('isf', next)) };
    }),
  setPumpModel: (id) =>
    set((s) => {
      const model = pumpModel(id);
      // Only pumps that report a reservoir rewind can act on this setting.
      return { pumpModelId: model.id, basal: snapItems(s.basal, scheduleOptions('basal', { units: s.units, pumpModelId: model.id })), rewindResetsAutosens: model.reportsRewindEvents };
    }),
  seedMaxIOB: () => {
    const s = get();
    if (s.maxIOB <= 0) set({ maxIOB: suggestedMaxIOB(totalDailyBasal(s.basal)) });
  },
}));

export const resetOnboardingDraft = () => useOnboardingDraft.setState({ ...DEFAULT_DRAFT, acknowledged: false, nightscout: DEFAULT_NIGHTSCOUT });

/**
 * Onboarding choices Buddy's settings store has no field for yet, persisted for the features that
 * will consume them (pump model → basal increments, Nightscout upload details, Max COB).
 */
interface OnboardingPrefs {
  readonly pumpModelId: string;
  readonly basalIncrement: number;
  readonly maxCOB: number;
  readonly nightscoutUploadGlucose: boolean;
  readonly nightscoutUploadCGMSensorStates: boolean;
  readonly disclaimerAcknowledgedAt: number | null;
  readonly notificationsGranted: boolean;
  readonly bluetoothGranted: boolean;
  update(patch: Partial<Omit<OnboardingPrefs, 'update'>>): void;
}

export const useOnboardingPrefs = create<OnboardingPrefs>()(
  persist(
    (set) => ({
      pumpModelId: DEFAULT_DRAFT.pumpModelId,
      basalIncrement: pumpModel(DEFAULT_DRAFT.pumpModelId).basal.step,
      maxCOB: DEFAULT_DRAFT.maxCOB,
      nightscoutUploadGlucose: true,
      nightscoutUploadCGMSensorStates: true,
      disclaimerAcknowledgedAt: null,
      notificationsGranted: false,
      bluetoothGranted: false,
      update: (patch) => set(patch),
    }),
    {
      name: 'buddy.onboarding.v1',
      storage: createJSONStorage(() => Storage),
      partialize: ({ update: _u, ...rest }) => rest,
    },
  ),
);
