import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import Storage from 'expo-sqlite/kv-store';
import {
  DEFAULT_ALERT_SETTINGS,
  type AlertSettings,
  type AlertSnoozes,
  DEFAULT_OVERRIDE_PRESETS,
  DEFAULT_TEMP_TARGET_PRESETS,
  type ActiveOverride,
  type ActiveTempTarget,
  type OverridePreset,
  type TempTargetPreset,
  DEFAULT_LIMITS,
  DEFAULT_PROFILE,
  type GlucoseUnit,
  type LoopMode,
  type SafetyLimits,
  type SettingsValues,
  type TherapyProfile,
} from '@buddy/core';

export type Appearance = 'system' | 'dark' | 'light';

export interface AppSettings {
  readonly onboarded: boolean;
  readonly appearance: Appearance;
  readonly units: GlucoseUnit;
  readonly loopMode: LoopMode;
  readonly algorithmId: string;
  readonly algorithmSettings: Readonly<Record<string, SettingsValues>>;
  readonly pumpId: string;
  readonly cgmId: string;
  /** Non-secret device settings by plugin id. Secret fields live in SecureStore. */
  readonly deviceSettings: Readonly<Record<string, SettingsValues>>;
  readonly profile: TherapyProfile;
  readonly limits: SafetyLimits;
  /** Share of the calculated bolus that the calculator recommends (Trio default 0.7). */
  readonly bolusFraction: number;
  readonly tempTarget: ActiveTempTarget | null;
  readonly override: ActiveOverride | null;
  readonly overridePresets: readonly OverridePreset[];
  readonly tempTargetPresets: readonly TempTargetPreset[];
  readonly alerts: AlertSettings;
  readonly alertSnoozes: AlertSnoozes;
  /** Nightscout site Buddy uploads to (token lives in the keychain). */
  readonly nightscoutUrl: string;
  readonly nightscoutUpload: boolean;
  /** Upload high-water marks, so restarts do not re-upload. */
  readonly nightscoutState: Readonly<Record<string, number>>;
}

interface Actions {
  update(patch: Partial<AppSettings>): void;
  setAlgorithmSettings(id: string, values: SettingsValues): void;
  setDeviceSettings(id: string, values: SettingsValues): void;
  reset(): void;
}

const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

export const DEFAULT_SETTINGS: AppSettings = {
  onboarded: false,
  appearance: 'system',
  units: 'mg/dL',
  loopMode: 'open',
  algorithmId: 'oref-smb',
  algorithmSettings: {},
  // Demo devices are registered in dev builds only; release builds start without devices.
  pumpId: IS_DEV ? 'demo-pump' : '',
  cgmId: IS_DEV ? 'demo-cgm' : '',
  deviceSettings: {},
  profile: DEFAULT_PROFILE,
  limits: DEFAULT_LIMITS,
  bolusFraction: 0.7,
  tempTarget: null,
  override: null,
  overridePresets: DEFAULT_OVERRIDE_PRESETS,
  tempTargetPresets: DEFAULT_TEMP_TARGET_PRESETS,
  alerts: DEFAULT_ALERT_SETTINGS,
  alertSnoozes: {},
  nightscoutUrl: '',
  nightscoutUpload: false,
  nightscoutState: {},
};

export const useSettings = create<AppSettings & Actions>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => set((s) => ({ ...s, ...patch })),
      setAlgorithmSettings: (id, values) => set((s) => ({ algorithmSettings: { ...s.algorithmSettings, [id]: values } })),
      setDeviceSettings: (id, values) => set((s) => ({ deviceSettings: { ...s.deviceSettings, [id]: values } })),
      reset: () => set(() => ({ ...DEFAULT_SETTINGS })),
    }),
    {
      name: 'buddy.settings.v1',
      version: 3,
      migrate: (persisted) => ({ ...DEFAULT_SETTINGS, ...(persisted as Partial<AppSettings>), tempTarget: null, override: null }),
      storage: createJSONStorage(() => Storage),
      partialize: ({ update: _u, setAlgorithmSettings: _a, setDeviceSettings: _d, reset: _r, ...rest }) => rest,
    },
  ),
);
