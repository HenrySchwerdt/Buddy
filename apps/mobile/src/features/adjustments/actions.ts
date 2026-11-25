import {
  DEFAULT_TARGET_BEHAVIOR,
  newId,
  type ActiveOverride,
  type ActiveTempTarget,
  type OverridePreset,
  type TargetBehavior,
  type TempTargetPreset,
} from '@buddy/core';
import { currentAlgorithm, now, runLoop } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { useAdjustmentsStore } from './store';

/**
 * Adjustments actions (ported from Trio's Adjustments StateModel). Every change that the
 * algorithm sees triggers a loop run, like Trio's `apsManager.determineBasalSync()`.
 */

const SCHEDULER_INTERVAL_MS = 15_000;

const settings = () => useSettings.getState();

function apply(patch: Parameters<ReturnType<typeof useSettings.getState>['update']>[0]) {
  settings().update(patch);
  void runLoop();
}

// --- Overrides ---------------------------------------------------------------------------------

/** Trio `enactOverridePreset`: a running copy of the preset; editing the preset edits the run. */
export function startOverridePreset(p: OverridePreset) {
  apply({ override: { ...p, startedAt: now(), presetId: p.id } });
}

/** Trio `saveCustomOverride`: starts a one-off override (empty name → "Override <date>"). */
export function startCustomOverride(draft: Omit<OverridePreset, 'id'>) {
  apply({ override: { ...draft, name: draft.name || defaultOverrideName(), id: newId('override'), startedAt: now() } });
}

export function cancelOverride() {
  apply({ override: null });
}

/** Trio `saveOverridePreset`. */
export function saveOverridePreset(draft: Omit<OverridePreset, 'id'> & { id?: string }): OverridePreset {
  const s = settings();
  const preset: OverridePreset = { ...draft, name: draft.name || defaultOverrideName(), id: draft.id ?? newId('override') };
  const exists = s.overridePresets.some((x) => x.id === preset.id);
  const overridePresets = exists ? s.overridePresets.map((x) => (x.id === preset.id ? preset : x)) : [...s.overridePresets, preset];
  // "If an active override preset is edited, the changes will also apply to the currently running override."
  const running = s.override?.presetId === preset.id ? { ...preset, startedAt: s.override.startedAt, presetId: preset.id } : null;
  if (running) apply({ overridePresets, override: running });
  else s.update({ overridePresets });
  return preset;
}

/**
 * Edit of the running override. Trio first copies a running preset into a custom override, so
 * the preset stays unchanged; an unchanged name then becomes "Custom Override".
 */
export function saveRunningOverride(original: ActiveOverride, edited: Omit<OverridePreset, 'id'>) {
  const name = !edited.name || edited.name === original.name ? 'Custom Override' : edited.name;
  apply({ override: { ...edited, name, id: newId('override'), startedAt: original.startedAt } });
}

export function deleteOverridePreset(id: string) {
  const s = settings();
  const overridePresets = s.overridePresets.filter((x) => x.id !== id);
  if (s.override?.presetId === id) apply({ overridePresets, override: null });
  else s.update({ overridePresets });
}

export function moveOverridePreset(id: string, delta: -1 | 1) {
  const s = settings();
  settings().update({ overridePresets: moved(s.overridePresets, id, delta) });
}

const defaultOverrideName = () => `Override ${new Date(now()).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;

// --- Temp targets ------------------------------------------------------------------------------

export function startTempTargetPreset(p: TempTargetPreset) {
  apply({ tempTarget: { ...p, startedAt: now(), presetId: p.id } });
}

/** Trio `invokeSaveOfCustomTempTargets`: future start → scheduled, otherwise now. */
export function startCustomTempTarget(draft: Omit<TempTargetPreset, 'id'>, startAt: number) {
  const t: ActiveTempTarget = { ...draft, name: draft.name || 'Custom Target', id: newId('target'), startedAt: Math.max(startAt, now()) };
  if (startAt > now()) {
    const store = useAdjustmentsStore.getState();
    store.setScheduled([...store.scheduledTempTargets, t]);
    ensureScheduler();
  } else {
    apply({ tempTarget: t });
  }
}

export function cancelTempTarget() {
  apply({ tempTarget: null });
}

export function saveTempTargetPreset(draft: Omit<TempTargetPreset, 'id'> & { id?: string }): TempTargetPreset {
  const s = settings();
  const preset: TempTargetPreset = { ...draft, name: draft.name || 'Custom Target', id: draft.id ?? newId('target') };
  const exists = s.tempTargetPresets.some((x) => x.id === preset.id);
  s.update({ tempTargetPresets: exists ? s.tempTargetPresets.map((x) => (x.id === preset.id ? preset : x)) : [...s.tempTargetPresets, preset] });
  return preset;
}

/** Trio `EditTempTargetForm` save for the running or a scheduled temp target. */
export function saveEditedTempTarget(original: ActiveTempTarget, edited: Omit<TempTargetPreset, 'id'>, startAt: number) {
  const store = useAdjustmentsStore.getState();
  const isScheduled = store.scheduledTempTargets.some((x) => x.id === original.id);
  const next: ActiveTempTarget = { ...edited, id: original.id, startedAt: startAt };
  if (isScheduled) {
    const rest = store.scheduledTempTargets.filter((x) => x.id !== original.id);
    if (startAt > now()) store.setScheduled([...rest, next]);
    else {
      store.setScheduled(rest);
      apply({ tempTarget: { ...next, startedAt: now() } });
    }
    return;
  }
  if (startAt > now()) {
    // The running temp target was moved to a later start: it becomes a scheduled one.
    store.setScheduled([...store.scheduledTempTargets, next]);
    ensureScheduler();
    apply({ tempTarget: null });
    return;
  }
  apply({ tempTarget: { ...next, presetId: undefined } });
}

export function deleteTempTargetPreset(id: string) {
  const s = settings();
  const tempTargetPresets = s.tempTargetPresets.filter((x) => x.id !== id);
  if (s.tempTarget?.presetId === id) apply({ tempTargetPresets, tempTarget: null });
  else s.update({ tempTargetPresets });
}

export function deleteScheduledTempTarget(id: string) {
  const store = useAdjustmentsStore.getState();
  store.setScheduled(store.scheduledTempTargets.filter((x) => x.id !== id));
}

export function moveTempTargetPreset(id: string, delta: -1 | 1) {
  settings().update({ tempTargetPresets: moved(settings().tempTargetPresets, id, delta) });
}

/** Starts scheduled temp targets whose time has come (Trio `waitUntilDate` + `enableScheduledTempTarget`). */
export function promoteDueTempTargets() {
  const store = useAdjustmentsStore.getState();
  const t = now();
  const due = store.scheduledTempTargets.filter((x) => x.startedAt <= t);
  if (due.length === 0) return;
  store.setScheduled(store.scheduledTempTargets.filter((x) => x.startedAt > t));
  // The latest due one wins, as each enable disables the ones before it.
  apply({ tempTarget: due[due.length - 1]! });
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/** Keeps a timer running while temp targets are scheduled. Idempotent. */
export function ensureScheduler() {
  promoteDueTempTargets();
  if (schedulerTimer || useAdjustmentsStore.getState().scheduledTempTargets.length === 0) return;
  schedulerTimer = setInterval(() => {
    promoteDueTempTargets();
    if (useAdjustmentsStore.getState().scheduledTempTargets.length === 0 && schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }, SCHEDULER_INTERVAL_MS);
}

useAdjustmentsStore.persist.onFinishHydration(() => ensureScheduler());

// --- Settings the forms read -------------------------------------------------------------------

/** Algorithm values the Adjustments UI shows (Trio reads them from Preferences). */
export function adjustmentDefaults(): { smbMinutes: number; uamMinutes: number; behavior: TargetBehavior } {
  const algo = currentAlgorithm();
  const raw = { ...algo.defaultSettings, ...(settings().algorithmSettings[algo.meta.id] ?? {}) } as Record<string, unknown>;
  const num = (k: string, d: number) => (typeof raw[k] === 'number' ? (raw[k] as number) : d);
  const bool = (k: string, d: boolean) => (typeof raw[k] === 'boolean' ? (raw[k] as boolean) : d);
  return {
    smbMinutes: num('maxSMBBasalMinutes', 30),
    uamMinutes: num('maxUAMSMBBasalMinutes', 30),
    behavior: {
      halfBasalExerciseTarget: num('halfBasalExerciseTarget', DEFAULT_TARGET_BEHAVIOR.halfBasalExerciseTarget),
      highTemptargetRaisesSensitivity: bool('highTemptargetRaisesSensitivity', DEFAULT_TARGET_BEHAVIOR.highTemptargetRaisesSensitivity),
      lowTemptargetLowersSensitivity: bool('lowTemptargetLowersSensitivity', DEFAULT_TARGET_BEHAVIOR.lowTemptargetLowersSensitivity),
      exerciseMode: bool('exerciseMode', DEFAULT_TARGET_BEHAVIOR.exerciseMode),
      autosensMax: num('autosensMax', DEFAULT_TARGET_BEHAVIOR.autosensMax),
    },
  };
}

function moved<T extends { id: string }>(list: readonly T[], id: string, delta: -1 | 1): T[] {
  const i = list.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
