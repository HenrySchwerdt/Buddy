import { formatGlucose } from '@buddy/core';
import { cancelOverride, cancelTempTarget, startOverridePreset, startTempTargetPreset } from '@/features/adjustments/actions';
import { useTrioPrefs } from '@/features/settings/store';
import { useMealPresets } from '@/features/treatment/presets-store';
import { useTreatmentSettings } from '@/features/treatment/settings-store';
import { invokeTreatments } from '@/features/treatment/submit';
import { restartLiveActivityNow } from './background';
import { checkBolusSafety } from './bolus-safety';
import { currentPump, now, store } from './runtime';
import { useSettings } from './settings-store';
import type { ShortcutAction } from './shortcuts-link';
import { prepareShortcut, type ExecutionPlan, type PreparedShortcut, type ShortcutContext } from './shortcuts-prepare';

/**
 * Runtime side of Shortcuts / App Intents / Android app shortcuts / buddy:// links (Trio `Shortcuts/*`).
 *
 * Safety contract: nothing here runs because a link or an intent asked for it. `prepareShortcut` only
 * describes the action; `confirmShortcut` is called by the in-app confirmation screen's button and
 * re-validates against the state at that moment (limits, IOB, recent boluses) before it acts.
 */

export function shortcutContext(): ShortcutContext {
  const s = useSettings.getState();
  const ts = useTreatmentSettings.getState();
  const t = now();
  return {
    now: t,
    allowBolusByShortcuts: useTrioPrefs.getState().allowBolusByShortcuts,
    hasPump: currentPump() !== null,
    maxBolus: s.limits.maxBolus,
    maxCarbs: ts.maxCarbs,
    maxFat: ts.maxFat,
    maxProtein: ts.maxProtein,
    checkBolus: (units) => checkBolusSafety({ units, limits: s.limits, profile: s.profile, doses: store.snapshot().doses, now: t, source: 'app' }),
    mealPresets: useMealPresets.getState().presets,
    overridePresets: s.overridePresets,
    tempTargetPresets: s.tempTargetPresets,
    activeOverride: s.override,
    activeTempTarget: s.tempTarget,
    formatTarget: (mgdl) => `${formatGlucose(mgdl, s.units)} ${s.units}`,
  };
}

export const prepare = (action: ShortcutAction): PreparedShortcut => prepareShortcut(action, shortcutContext());

export type ShortcutResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };

async function run(plan: ExecutionPlan): Promise<ShortcutResult> {
  const ts = useTreatmentSettings.getState();
  const limits = useSettings.getState().limits;
  const base = { note: '', externalInsulin: false, date: now(), backdated: false, maxBolus: limits.maxBolus, maxCarbs: ts.maxCarbs, maxFat: ts.maxFat, maxProtein: ts.maxProtein, fpu: ts };
  switch (plan.type) {
    case 'bolus': {
      const r = await invokeTreatments({ ...base, carbs: 0, fat: 0, protein: 0, amount: plan.units });
      return r.ok ? { ok: true, message: `${plan.units} U bolus delivered.` } : { ok: false, message: r.message };
    }
    case 'carbs': {
      // Like Trio's Shortcuts, fat and protein only count when Meal Settings → Fat and Protein is on.
      const fpu = ts.useFPUconversion;
      const r = await invokeTreatments({ ...base, note: plan.note, carbs: plan.grams, fat: fpu ? plan.fat : 0, protein: fpu ? plan.protein : 0, amount: 0 });
      return r.ok ? { ok: true, message: `${plan.grams} g carbs logged.` } : { ok: false, message: r.message };
    }
    case 'overrideApply':
      startOverridePreset(plan.preset);
      return { ok: true, message: `Override "${plan.preset.name}" started.` };
    case 'overrideCancel':
      cancelOverride();
      return { ok: true, message: 'Override cancelled.' };
    case 'tempTargetApply':
      startTempTargetPreset(plan.preset);
      return { ok: true, message: `Temp target "${plan.preset.name}" started.` };
    case 'tempTargetCancel':
      cancelTempTarget();
      return { ok: true, message: 'Temp target cancelled.' };
    case 'restartLiveActivity':
      return (await restartLiveActivityNow()) ? { ok: true, message: 'Live Activity restarted.' } : { ok: false, message: 'The Live Activity could not be restarted. Check that Live Activities are allowed for Buddy and enabled in its settings.' };
    case 'state':
      return { ok: true, message: '' };
  }
}

/**
 * Called only by the confirmation button. The action is prepared again so a bolus that became unsafe while
 * the screen was open (new bolus, IOB changed, setting switched off) is refused instead of delivered.
 */
export async function confirmShortcut(action: ShortcutAction): Promise<ShortcutResult> {
  const fresh = prepare(action);
  if (!fresh.ok) return { ok: false, message: fresh.error };
  try {
    return await run(fresh.plan);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
