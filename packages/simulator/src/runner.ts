import {
  computeIob,
  carbsOnBoard,
  createLoopEngine,
  createMemoryStore,
  glucoseStatus,
  guardManualBolus,
  recommendBolus,
  silentLogger,
  DEFAULT_LIMITS,
  MINUTE,
  type AlgorithmPlugin,
  type LoopMode,
  type SafetyLimits,
  type SettingsValues,
} from '@buddy/core';
import { computeMetrics, type GlycemicMetrics } from './metrics';
import { profileFor, type VirtualPatient } from './patients';
import type { Scenario } from './scenarios';
import { createVirtualWorld } from './world';

export interface TracePoint {
  readonly t: number;
  /** True plasma glucose, mg/dL */
  readonly bg: number;
  readonly cgm: number | null;
  readonly iob: number;
  readonly cob: number;
  /** Basal rate actually running, U/h */
  readonly basal: number;
  readonly autoBolus: number;
  readonly bolus: number;
  readonly carbs: number;
}

export interface SimulationOptions {
  readonly algorithm: AlgorithmPlugin;
  readonly settings?: SettingsValues;
  readonly patient: VirtualPatient;
  readonly scenario: Scenario;
  readonly mode?: LoopMode;
  readonly limits?: SafetyLimits;
  readonly seed?: number;
  readonly start?: number;
  /** Called with progress 0–1; return a promise to yield to the UI thread. */
  readonly onProgress?: (fraction: number) => void | Promise<void>;
}

export interface SimulationResult {
  readonly algorithmId: string;
  readonly patientId: string;
  readonly scenarioId: string;
  readonly mode: LoopMode;
  readonly trace: readonly TracePoint[];
  readonly metrics: GlycemicMetrics;
  readonly interventions: Readonly<Record<string, number>>;
  readonly loopErrors: number;
}

const LOOP_INTERVAL_MIN = 5;
const DEFAULT_START = Date.UTC(2026, 0, 1, 6, 0, 0);

/** Runs one algorithm on one virtual patient through one scenario, deterministically. */
export async function runSimulation(o: SimulationOptions): Promise<SimulationResult> {
  const start = o.start ?? DEFAULT_START;
  const mode = o.mode ?? 'closed';
  const profile = profileFor(o.patient, o.scenario.profileMismatch);
  const truthProfile = profileFor(o.patient, 1);
  const limits = o.limits ?? DEFAULT_LIMITS;
  const world = createVirtualWorld({ patient: o.patient, pumpProfile: profile, start, seed: o.seed ?? 42, startBasal: truthProfile.basal[0]!.value });
  const store = createMemoryStore();
  const settings = { ...o.algorithm.defaultSettings, ...(o.settings ?? {}) };
  const engine = createLoopEngine({
    clock: world.clock,
    pump: world.pump,
    cgm: world.cgm,
    store,
    log: silentLogger,
    config: () => ({ mode, algorithm: o.algorithm, algorithmSettings: settings, profile, limits }),
  });

  const trace: TracePoint[] = [];
  const interventions: Record<string, number> = {};
  let loopErrors = 0;
  const totalMinutes = o.scenario.hours * 60;
  let pending = { bolus: 0, carbs: 0 };

  for (let m = 0; m < totalMinutes; m++) {
    for (const meal of o.scenario.meals.filter((x) => x.at === m)) {
      world.eat(meal.grams);
      const logged = Math.round(meal.grams * (meal.countingError ?? 1));
      if (meal.announced) store.addCarbs({ id: `meal-${m}`, date: world.clock.now(), grams: logged });
      pending = { ...pending, carbs: pending.carbs + logged };
      if (meal.bolusFraction > 0) pending = { ...pending, bolus: pending.bolus + (await mealBolus(logged, meal.bolusFraction)) };
    }
    if (m % LOOP_INTERVAL_MIN === 0) {
      const run = await engine.run();
      if (run?.error) loopErrors++;
      run?.interventions.forEach((i) => (interventions[i.code] = (interventions[i.code] ?? 0) + 1));
      const status = await world.pump.status();
      const now = world.clock.now();
      const snap = store.snapshot();
      trace.push({
        t: now,
        bg: Math.round(world.trueGlucose()),
        cgm: world.readings().at(-1)?.value ?? null,
        iob: Math.round(computeIob(snap.doses, profile, now).iob * 100) / 100,
        cob: Math.round(carbsOnBoard(snap.carbs, now)),
        basal: status.tempBasal ? status.tempBasal.rate : profile.basal[0]!.value,
        autoBolus: run?.enacted?.autoBolus ?? 0,
        bolus: pending.bolus,
        carbs: pending.carbs,
      });
      pending = { bolus: 0, carbs: 0 };
      if (o.onProgress && trace.length % 24 === 0) await o.onProgress(m / totalMinutes);
    }
    world.advance(1);
  }

  async function mealBolus(grams: number, fraction: number): Promise<number> {
    const now = world.clock.now();
    store.addDoses(await world.pump.history(now - 24 * 60 * MINUTE));
    const snap = store.snapshot();
    const status = glucoseStatus([...snap.glucose, ...world.readings()]);
    const rec = recommendBolus({
      now,
      profile,
      glucose: status?.glucose ?? null,
      delta: status?.delta ?? 0,
      carbs: grams,
      iob: computeIob(snap.doses, profile, now).iob,
      fraction,
    });
    const { units } = guardManualBolus(rec.total, limits.maxBolus, 0.05);
    if (units <= 0) return 0;
    const r = await world.pump.bolus(units, { automatic: false });
    return r.ok ? units : 0;
  }

  const doses = world.doses();
  const sumBolus = (kinds: string[]) => doses.reduce((s, d) => (kinds.includes(d.kind) && 'units' in d ? s + d.units : s), 0);
  const basalTotal = trace.reduce((s, p) => s + (p.basal * LOOP_INTERVAL_MIN) / 60, 0);
  const metrics = computeMetrics(trace.map((p) => p.bg), LOOP_INTERVAL_MIN, { total: basalTotal + sumBolus(['bolus', 'smb']), auto: sumBolus(['smb']) });
  await o.onProgress?.(1);
  return { algorithmId: o.algorithm.meta.id, patientId: o.patient.id, scenarioId: o.scenario.id, mode, trace, metrics, interventions, loopErrors };
}
