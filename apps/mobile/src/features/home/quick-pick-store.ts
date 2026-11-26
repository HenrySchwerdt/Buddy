import * as Haptics from 'expo-haptics';
import { create } from 'zustand';
import { deliverBolus, logCarbs, now, runLoop, store } from '@/runtime/runtime';
import { requireBolusUnlock } from '@/runtime/unlock';
import { useSettings } from '@/runtime/settings-store';
import { useTreatmentSettings } from '@/features/treatment/settings-store';
import { useTrioPrefs } from '@/features/settings/store';
import { quickPickSuggestions, type QuickPickOutcome } from './quick-pick';

/** Home's quick-pick state (`showQuickPickTreatmentsPicker` / `showQuickPickTreatmentsNoHistory` / suggestions). */
interface QuickPickState {
  readonly picker: boolean;
  readonly noHistory: boolean;
  readonly bolus: readonly number[];
  readonly carbs: readonly number[];
  close(): void;
}

export const useQuickPick = create<QuickPickState>((set) => ({ picker: false, noHistory: false, bolus: [], carbs: [], close: () => set({ picker: false, noHistory: false }) }));

/** `loadQuickPickTreatmentSuggestions`: manual pump boluses (no SMB, no external) and carb entries (no FPU). */
export function loadQuickPickSuggestions(at = now()) {
  const snap = store.snapshot();
  const boluses = snap.doses.flatMap((d) => (d.kind === 'bolus' && !d.external ? [{ amount: d.units, timestamp: d.date }] : []));
  const carbs = snap.carbs.flatMap((e) => (e.id.startsWith('fpu') ? [] : [{ amount: e.grams, timestamp: e.date }]));
  return quickPickSuggestions({ boluses, carbs }, { maxBolus: useSettings.getState().limits.maxBolus, maxCarbs: useTreatmentSettings.getState().maxCarbs }, at);
}

/** Long press on the treatment button: heavy haptic, then the picker or the "no history" alert. */
export function openQuickPick(): void {
  if (!useTrioPrefs.getState().enableQuickPickTreatments) return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  const s = loadQuickPickSuggestions();
  const empty = s.bolus.length === 0 && s.carbs.length === 0;
  useQuickPick.setState({ bolus: s.bolus, carbs: s.carbs, picker: !empty, noHistory: empty });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `enactQuickPickTreatment`: carbs and bolus run concurrently, each reports its own result. */
export async function enactQuickPick(bolus: number | null, carbs: number | null): Promise<QuickPickOutcome> {
  const maxCarbs = useTreatmentSettings.getState().maxCarbs;
  const maxBolus = useSettings.getState().limits.maxBolus;
  const carbsTask = carbs === null ? Promise.resolve(null) : carbs > 0 ? logCarbs(Math.min(carbs, maxCarbs)).then(() => 'succeeded' as const, () => 'failed' as const) : Promise.resolve('failed' as const);
  const bolusTask: Promise<{ result: 'succeeded' | 'failed' | null; failure?: string }> =
    bolus === null ? Promise.resolve({ result: null }) : bolus > 0 ? requireBolusUnlock().then(() => deliverBolus(Math.min(bolus, maxBolus))).then(() => ({ result: 'succeeded' as const }), (e) => ({ result: 'failed' as const, failure: message(e) })) : Promise.resolve({ result: 'failed' as const });
  const [carbsResult, bolusResult] = await Promise.all([carbsTask, bolusTask]);
  // Updates IOB / COB (Trio: determineBasalSync after carbs, bolus triggers its own).
  await runLoop().catch(() => null);
  return { carbs: carbsResult, bolus: bolusResult.result, bolusFailureMessage: bolusResult.failure ?? null };
}
