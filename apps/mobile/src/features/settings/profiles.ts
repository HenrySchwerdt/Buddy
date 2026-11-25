import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Schedule, TargetRange, TherapyProfile } from '@buddy/core';
import { useSettings } from '@/runtime/settings-store';

/** The four schedules a Trio therapy profile holds. */
export interface ProfileSchedules {
  readonly basal: Schedule;
  readonly isf: Schedule;
  readonly carbRatio: Schedule;
  readonly target: Schedule<TargetRange>;
}

export interface StoredProfile extends ProfileSchedules {
  readonly name: string;
}

export const DEFAULT_PROFILE_NAME = 'Default';
const MAX_NAME_LENGTH = 30;

/**
 * Port of Trio's TherapyProfileManager. The active profile always lives in
 * `useSettings().profile` (the loop reads it from there); stored copies of the active
 * profile are refreshed when another profile is activated.
 */
interface ProfilesState {
  readonly activeName: string;
  readonly profiles: readonly StoredProfile[];
  saveActiveAsNew(name: string): void;
  activate(name: string): void;
  rename(name: string, to: string): void;
  remove(name: string): void;
  updateStored(name: string, patch: Partial<ProfileSchedules>): void;
}

export const schedulesOf = (p: TherapyProfile | ProfileSchedules): ProfileSchedules => ({ basal: p.basal, isf: p.isf, carbRatio: p.carbRatio, target: p.target });

export const useProfiles = create<ProfilesState>()(
  persist(
    (set, get) => ({
      activeName: DEFAULT_PROFILE_NAME,
      profiles: [],
      saveActiveAsNew: (name) => {
        const live = schedulesOf(useSettings.getState().profile);
        set((s) => ({ profiles: [...withActiveSnapshot(s), { name: name.trim(), ...live }] }));
      },
      activate: (name) => {
        const s = get();
        const target = withActiveSnapshot(s).find((p) => p.name === name);
        if (!target || name === s.activeName) return;
        const settings = useSettings.getState();
        set({ profiles: withActiveSnapshot(s), activeName: name });
        settings.update({ profile: { ...settings.profile, ...schedulesOf(target) } });
      },
      rename: (name, to) =>
        set((s) => ({
          profiles: withActiveSnapshot(s).map((p) => (p.name === name ? { ...p, name: to.trim() } : p)),
          activeName: s.activeName === name ? to.trim() : s.activeName,
        })),
      remove: (name) => set((s) => ({ profiles: withActiveSnapshot(s).filter((p) => p.name !== name || p.name === s.activeName) })),
      updateStored: (name, patch) => set((s) => ({ profiles: s.profiles.map((p) => (p.name === name ? { ...p, ...patch } : p)) })),
    }),
    {
      name: 'buddy.settings-a.profiles.v1',
      storage: createJSONStorage(() => Storage),
      partialize: ({ activeName, profiles }) => ({ activeName, profiles }),
    },
  ),
);

/** Stored list with the Default entry present and the active entry refreshed from the live settings. */
function withActiveSnapshot(s: Pick<ProfilesState, 'activeName' | 'profiles'>): StoredProfile[] {
  const live = schedulesOf(useSettings.getState().profile);
  const list = s.profiles.some((p) => p.name === DEFAULT_PROFILE_NAME) ? [...s.profiles] : [{ name: DEFAULT_PROFILE_NAME, ...live }, ...s.profiles];
  return list.map((p) => (p.name === s.activeName ? { ...p, ...live } : p));
}

/** All profiles, Default first, with the active one showing the live schedules. */
export function useProfileList(): StoredProfile[] {
  const activeName = useProfiles((s) => s.activeName);
  const profiles = useProfiles((s) => s.profiles);
  useSettings((s) => s.profile);
  return withActiveSnapshot({ activeName, profiles });
}

/** Port of TherapyProfiles.StateModel.nameProblem. */
export function nameProblem(name: string, existing: readonly string[], renaming?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name for the new profile.';
  if (trimmed.length > MAX_NAME_LENGTH) return `A name can have at most ${MAX_NAME_LENGTH} characters.`;
  if (trimmed !== renaming && existing.some((n) => n.toLowerCase() === trimmed.toLowerCase())) return 'A profile with this name already exists.';
  return null;
}

/**
 * Schedules an editor works on: the live settings when `profileName` is empty or active,
 * otherwise the stored profile. Returns the schedules and a saver.
 */
export function useEditableSchedules(profileName: string | undefined): { schedules: ProfileSchedules; save: (patch: Partial<ProfileSchedules>) => void; banner: { name: string; active: boolean } | null } {
  const list = useProfileList();
  const activeName = useProfiles((s) => s.activeName);
  const updateStored = useProfiles((s) => s.updateStored);
  const live = useSettings((s) => s.profile);
  const update = useSettings((s) => s.update);
  const editsLive = !profileName || profileName === activeName;
  const stored = list.find((p) => p.name === profileName);
  const banner = profileName ? { name: profileName, active: editsLive } : list.length > 1 ? { name: activeName, active: true } : null;
  if (editsLive || !stored) {
    return { schedules: schedulesOf(live), save: (patch) => update({ profile: { ...useSettings.getState().profile, ...patch } }), banner };
  }
  return { schedules: schedulesOf(stored), save: (patch) => updateStored(stored.name, patch), banner };
}
