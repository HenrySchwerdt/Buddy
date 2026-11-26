import type { AlgorithmDecision, AlgorithmInput } from './algorithm';
import type { Millis } from './types';
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

// ---------------------------------------------------------------------------------------------
// Bolus safety validator (port of Trio's BolusSafetyValidator / BolusSafetyEvaluator)
// ---------------------------------------------------------------------------------------------

/** Trio `BolusSafetyEvaluator.recentBolusThreshold`: recent insulin >= 20% of the request blocks it. */
export const RECENT_BOLUS_THRESHOLD = 0.2;
/** Trio `BolusSafetyEvaluator.recentBolusWindowMinutes`. */
export const RECENT_BOLUS_WINDOW_MINUTES = 6;
/** Buddy addition: an IOB value older than this is treated as unavailable (only when its age is supplied). */
export const DEFAULT_MAX_IOB_AGE_MINUTES = 30;
/** Absorbs binary float noise where Trio compares exact Decimals (e.g. 0.3 * 0.2). */
const EPS = 1e-9;

export type BolusSafetyRejection =
  | { readonly reason: 'exceedsMaxBolus'; readonly maxBolus: number }
  | { readonly reason: 'iobUnavailable' }
  | { readonly reason: 'exceedsMaxIOB'; readonly currentIOB: number; readonly maxIOB: number }
  | { readonly reason: 'recentBolusWithinWindow'; readonly totalRecent: number };

export type BolusSafetyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: BolusSafetyRejection; readonly message: string };

/** A bolus (manual, SMB or external) already in history. */
export interface RecentBolus {
  readonly date: Millis;
  readonly units: number;
}

export interface BolusSafetyInput {
  /** Requested bolus, U. */
  readonly units: number;
  /** Pump setting max bolus, U. */
  readonly maxBolus: number;
  /** Preference max IOB, U. */
  readonly maxIOB: number;
  /** Current IOB, U; null/undefined = not available. */
  readonly currentIOB: number | null | undefined;
  /** When `currentIOB` was computed. If given, an older value than `maxIobAgeMinutes` counts as unavailable. */
  readonly iobDate?: Millis;
  readonly maxIobAgeMinutes?: number;
  /** Bolus history; only entries newer than the lookback start are summed (Trio sums every bolus event, SMBs and external included). */
  readonly recentBoluses: readonly RecentBolus[];
  /**
   * Start of the recent-bolus window. Defaults to `now - 6 min`. For commands issued earlier
   * (remote command timestamp) pass that time so any bolus since the command was sent counts.
   */
  readonly lookbackStart?: Millis;
  readonly now: Millis;
  /** Wording: 'app' = bolus screen / Shortcuts (default), 'remote' = remote command responses. */
  readonly source?: 'app' | 'remote';
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/** User-facing text for a rejection; wording follows Trio's Shortcuts ('app') and remote-command ('remote') messages. */
export function describeBolusRejection(rejection: BolusSafetyRejection, requestedUnits: number, source: 'app' | 'remote' = 'app'): string {
  if (source === 'remote') {
    switch (rejection.reason) {
      case 'exceedsMaxBolus':
        return `Command rejected: bolus amount (${fmt(requestedUnits)} units) exceeds the maximum allowed (${fmt(rejection.maxBolus)} units).`;
      case 'iobUnavailable':
        return 'Command rejected: current IOB is not available.';
      case 'exceedsMaxIOB':
        return `Command rejected: bolus amount (${fmt(requestedUnits)} units) would exceed max IOB (${fmt(rejection.maxIOB)} units). Current IOB: ${fmt(rejection.currentIOB)} units.`;
      case 'recentBolusWithinWindow':
        return 'Command rejected: boluses totaling more than 20% of the requested amount have been delivered since the command was sent.';
    }
  }
  switch (rejection.reason) {
    case 'exceedsMaxBolus':
      return `The bolus cannot be larger than the pump setting max bolus (${fmt(rejection.maxBolus)}).`;
    case 'iobUnavailable':
      return 'Bolus blocked: current IOB is not available.';
    case 'exceedsMaxIOB':
      return `Bolus blocked: a ${fmt(requestedUnits)} U bolus would exceed max IOB (${fmt(rejection.maxIOB)} U). Current IOB: ${fmt(rejection.currentIOB)} U.`;
    case 'recentBolusWithinWindow':
      return `Bolus blocked: a significant bolus was delivered within the last ${RECENT_BOLUS_WINDOW_MINUTES} minutes.`;
  }
}

/** Sum of bolus units newer than `since` (Trio `fetchTotalRecentBolusAmount`: `timestamp > since`, no upper bound). */
export const totalRecentBolus = (boluses: readonly RecentBolus[], since: Millis): number =>
  boluses.reduce((sum, b) => (b.date > since && Number.isFinite(b.units) ? sum + b.units : sum), 0);

/**
 * Trio's check order: max bolus, IOB availability, max IOB, recent boluses. The first failing
 * rule wins. Non-finite or negative requests are rejected as exceeding the max bolus (fail
 * closed). A zero request falls through to the recent-bolus rule exactly like Trio (0 >= 0).
 */
export function validateBolusSafety(input: BolusSafetyInput): BolusSafetyResult {
  const { units, maxBolus, maxIOB, now } = input;
  const reject = (rejection: BolusSafetyRejection): BolusSafetyResult => ({
    ok: false,
    rejection,
    message: describeBolusRejection(rejection, units, input.source),
  });

  if (!isFiniteNumber(units) || units < 0) return reject({ reason: 'exceedsMaxBolus', maxBolus });
  if (units > maxBolus + EPS) return reject({ reason: 'exceedsMaxBolus', maxBolus });

  const maxAge = (input.maxIobAgeMinutes ?? DEFAULT_MAX_IOB_AGE_MINUTES) * MINUTE;
  const stale = input.iobDate !== undefined && now - input.iobDate > maxAge;
  const iob = input.currentIOB;
  if (!isFiniteNumber(iob) || stale) return reject({ reason: 'iobUnavailable' });
  if (iob + units > maxIOB + EPS) return reject({ reason: 'exceedsMaxIOB', currentIOB: iob, maxIOB });

  const since = input.lookbackStart ?? now - RECENT_BOLUS_WINDOW_MINUTES * MINUTE;
  const recent = totalRecentBolus(input.recentBoluses, since);
  if (recent + EPS >= units * RECENT_BOLUS_THRESHOLD) return reject({ reason: 'recentBolusWithinWindow', totalRecent: recent });
  return { ok: true };
}
