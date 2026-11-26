import { setMaxAbsorptionHours } from '@buddy/core';
import { useTrioPrefs } from '@/features/settings/store';

let started = false;

/**
 * Applies Meal Settings > Max Meal Absorption Time to carb absorption (idempotent). Runs once the
 * persisted preferences are loaded and again on every change.
 */
export function startMealAbsorptionSync(): void {
  if (started) return;
  started = true;
  const apply = () => setMaxAbsorptionHours(useTrioPrefs.getState().maxMealAbsorptionTime);
  apply();
  useTrioPrefs.subscribe(apply);
  useTrioPrefs.persist?.onFinishHydration?.(apply);
}
