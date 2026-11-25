import {
  carbsOnBoard,
  computeIob,
  glucoseStatus,
  isOverrideActive,
  HOUR,
  MINUTE,
  type AlgorithmDecision,
  type AlgorithmInput,
  type CarbEntry,
  type InsulinDose,
} from '@buddy/core';
import { algorithmSettingsFor, currentAlgorithm, now as runtimeNow, store, useRuntime } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';

const HISTORY_WINDOW = 24 * HOUR;
const SIM_ID = 'sim-treatment';

export interface SimulationRequest {
  readonly carbs: number;
  readonly carbsDate: number;
  readonly bolus: number;
}

/**
 * Trio's `apsManager.simulateDetermineBasal(simulatedCarbsAmount:simulatedBolusAmount:simulatedCarbsDate:)`:
 * runs the active algorithm on the current data plus the entered carbs and bolus, without
 * enacting anything. Assembles the input exactly like the LoopEngine does.
 * Returns null when there is no pump state or no glucose (nothing to simulate on).
 */
export function simulateDecision(req: SimulationRequest): AlgorithmDecision | null {
  const pump = useRuntime.getState().pump;
  if (!pump) return null;
  const now = runtimeNow();
  const s = useSettings.getState();
  const snap = store.snapshot();
  const since = now - HISTORY_WINDOW;
  const glucose = snap.glucose.filter((g) => g.date >= since && g.date <= now).slice().reverse();
  const status = glucoseStatus(glucose);
  if (!status) return null;

  const extraDoses: InsulinDose[] = req.bolus > 0 ? [{ kind: 'bolus', date: now, units: req.bolus, id: SIM_ID }] : [];
  const extraCarbs: CarbEntry[] = req.carbs > 0 ? [{ id: SIM_ID, date: req.carbsDate, grams: req.carbs }] : [];
  const doses = [...snap.doses.filter((d) => d.date >= since), ...extraDoses];
  const carbs = [...snap.carbs, ...extraCarbs].filter((c) => c.date >= since && c.date <= now);
  const tempTarget = s.tempTarget ? { low: s.tempTarget.target, high: s.tempTarget.target, endsAt: s.tempTarget.startedAt + s.tempTarget.durationMin * MINUTE } : undefined;

  const input: AlgorithmInput = {
    now,
    glucose,
    glucoseStatus: status,
    doses,
    carbs,
    profile: s.profile,
    limits: s.limits,
    pump,
    iob: computeIob(doses, s.profile, now),
    cob: carbsOnBoard(carbs, now),
    tempTarget: tempTarget && tempTarget.endsAt > now ? tempTarget : undefined,
    override: isOverrideActive(s.override, now) ? s.override : undefined,
  };
  try {
    const algorithm = currentAlgorithm();
    return algorithm.decide(input, algorithmSettingsFor(algorithm));
  } catch (e) {
    console.warn(`[buddy] Treatment forecast simulation failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
