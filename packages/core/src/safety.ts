import type { AlgorithmDecision, AlgorithmInput } from './algorithm';
import { scheduleValueAt } from './schedule';
import { MINUTE } from './units';

/**
 * The SafetyGuard sits between every algorithm and the pump. It is deliberately small,
 * algorithm-agnostic and exhaustively tested. Algorithms can be wrong; the guard bounds
 * how wrong they can be. Limits are only ever tightened here, never relaxed.
 */

export type InterventionCode =
  | 'invalid-output'
  | 'stale-glucose'
  | 'low-glucose-suspend'
  | 'pump-suspended'
  | 'basal-clamped'
  | 'duration-clamped'
  | 'max-iob-basal'
  | 'bolus-clamped-max'
  | 'bolus-clamped-iob'
  | 'bolus-too-soon'
  | 'bolus-in-progress'
  | 'bolus-below-increment';

export interface SafetyIntervention {
  readonly code: InterventionCode;
  readonly message: string;
}

export interface GuardedDecision {
  readonly decision: AlgorithmDecision;
  readonly interventions: readonly SafetyIntervention[];
}

export const MAX_TEMP_DURATION_MIN = 120;
export const LOW_SUSPEND_DURATION_MIN = 30;
/** Minutes ahead used to extrapolate the current trend for the low-glucose check. */
const LOW_LOOKAHEAD_5MIN_STEPS = 3;

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const floorTo = (x: number, step: number): number => (step > 0 ? Math.floor(x / step + 1e-9) * step : x);
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export function guardDecision(input: AlgorithmInput, raw: AlgorithmDecision): GuardedDecision {
  const interventions: SafetyIntervention[] = [];
  const add = (code: InterventionCode, message: string) => interventions.push({ code, message });
  const { limits, pump, glucoseStatus, now } = input;
  const scheduled = scheduleValueAt(input.profile.basal, now, input.profile.utcOffsetMinutes);
  const base = { ...raw };

  // 1. Malformed output → do nothing but return to scheduled basal.
  const temp = raw.tempBasal;
  const tempInvalid = temp != null && (!isFiniteNumber(temp.rate) || !isFiniteNumber(temp.durationMin));
  const bolusInvalid = raw.autoBolus !== undefined && !isFiniteNumber(raw.autoBolus);
  if (tempInvalid || bolusInvalid) {
    add('invalid-output', 'Algorithm returned a non-numeric dose; falling back to scheduled basal.');
    return { decision: { ...base, tempBasal: null, autoBolus: undefined }, interventions };
  }

  // 2. Pump suspended → never command anything.
  if (pump.suspended) {
    add('pump-suspended', 'Pump is suspended; no automatic changes.');
    return { decision: { ...base, tempBasal: undefined, autoBolus: undefined }, interventions };
  }

  // 3. Stale CGM data → cancel temps, no boluses.
  const ageMin = (now - glucoseStatus.date) / MINUTE;
  if (ageMin > limits.maxGlucoseAgeMinutes) {
    add('stale-glucose', `Last glucose is ${Math.round(ageMin)} min old; returning to scheduled basal.`);
    return { decision: { ...base, tempBasal: null, autoBolus: undefined }, interventions };
  }

  // 4. Low or soon-low glucose → zero temp, no boluses.
  const projected = glucoseStatus.glucose + LOW_LOOKAHEAD_5MIN_STEPS * Math.min(0, glucoseStatus.delta);
  if (glucoseStatus.glucose < limits.suspendThreshold || projected < limits.suspendThreshold) {
    add('low-glucose-suspend', `Glucose at or heading below ${limits.suspendThreshold} mg/dL; zero temp basal.`);
    return {
      decision: { ...base, tempBasal: { rate: 0, durationMin: LOW_SUSPEND_DURATION_MIN }, autoBolus: undefined },
      interventions,
    };
  }

  // 5. Temp basal bounds.
  let tempBasal = raw.tempBasal;
  if (tempBasal) {
    let rate = Math.max(0, tempBasal.rate);
    let durationMin = tempBasal.durationMin;
    if (rate > limits.maxBasalRate) {
      add('basal-clamped', `Temp basal ${round3(rate)} U/h clamped to max ${limits.maxBasalRate} U/h.`);
      rate = limits.maxBasalRate;
    }
    if (input.iob.iob >= limits.maxIOB && rate > scheduled) {
      add('max-iob-basal', `IOB ${round3(input.iob.iob)} U ≥ max ${limits.maxIOB} U; no high temp.`);
      rate = scheduled;
    }
    if (durationMin <= 0 || durationMin > MAX_TEMP_DURATION_MIN) {
      add('duration-clamped', `Temp duration ${durationMin} min clamped to 1–${MAX_TEMP_DURATION_MIN} min.`);
      durationMin = Math.min(MAX_TEMP_DURATION_MIN, Math.max(1, durationMin));
    }
    tempBasal = { rate: round3(floorTo(rate, pump.basalIncrement)), durationMin };
  }

  // 6. Automatic bolus bounds.
  let autoBolus = raw.autoBolus;
  if (autoBolus !== undefined && autoBolus > 0) {
    autoBolus = guardAutoBolus(input, autoBolus, add);
  } else {
    autoBolus = undefined;
  }

  return { decision: { ...base, tempBasal, autoBolus }, interventions };
}

function guardAutoBolus(
  input: AlgorithmInput,
  requested: number,
  add: (code: InterventionCode, message: string) => void,
): number | undefined {
  const { limits, pump, now } = input;
  if (pump.bolusing) {
    add('bolus-in-progress', 'A bolus is already running.');
    return undefined;
  }
  const lastAuto = input.doses.filter((d) => d.kind === 'smb').reduce((m, d) => Math.max(m, d.date), 0);
  if (now - lastAuto < limits.minAutoBolusIntervalMinutes * MINUTE) {
    add('bolus-too-soon', `Last automatic bolus less than ${limits.minAutoBolusIntervalMinutes} min ago.`);
    return undefined;
  }
  let units = requested;
  const cap = Math.min(limits.maxAutoBolus, limits.maxBolus);
  if (units > cap) {
    add('bolus-clamped-max', `Automatic bolus ${round3(units)} U clamped to ${cap} U.`);
    units = cap;
  }
  const iobRoom = limits.maxIOB - input.iob.iob;
  if (units > iobRoom) {
    add('bolus-clamped-iob', `Automatic bolus limited by max IOB (${limits.maxIOB} U).`);
    units = Math.max(0, iobRoom);
  }
  units = round3(floorTo(units, pump.bolusIncrement));
  if (units < pump.bolusIncrement) {
    if (requested >= pump.bolusIncrement) add('bolus-below-increment', 'Automatic bolus rounded to zero.');
    return undefined;
  }
  return units;
}

/** Manual bolus check used by the bolus screen. Returns the allowed amount and warnings. */
export function guardManualBolus(units: number, maxBolus: number, increment: number): { units: number; warnings: string[] } {
  const warnings: string[] = [];
  if (!isFiniteNumber(units) || units <= 0) return { units: 0, warnings };
  let u = units;
  if (u > maxBolus) {
    warnings.push(`Limited to max bolus ${maxBolus} U.`);
    u = maxBolus;
  }
  return { units: round3(floorTo(u, increment)), warnings };
}
