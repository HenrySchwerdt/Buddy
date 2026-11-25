/**
 * Core domain types. All glucose values are mg/dL internally; convert at the UI edge
 * with `units.ts`. All timestamps are epoch milliseconds.
 */

export type Millis = number;

export type Trend =
  | 'doubleUp'
  | 'singleUp'
  | 'fortyFiveUp'
  | 'flat'
  | 'fortyFiveDown'
  | 'singleDown'
  | 'doubleDown'
  | 'unknown';

export interface GlucoseReading {
  readonly date: Millis;
  /** mg/dL */
  readonly value: number;
  readonly trend?: Trend;
  /** Identifier of the CGM source that produced the reading. */
  readonly source: string;
  readonly noise?: number;
}

export type DoseKind = 'bolus' | 'smb' | 'tempBasal' | 'suspend';

/** A delivered (or confirmed-enacted) insulin event. */
export type InsulinDose =
  | { readonly kind: 'bolus' | 'smb'; readonly date: Millis; readonly units: number; readonly id: string }
  | {
      readonly kind: 'tempBasal';
      readonly date: Millis;
      /** U/h absolute rate */
      readonly rate: number;
      readonly durationMin: number;
      readonly id: string;
    }
  | { readonly kind: 'suspend'; readonly date: Millis; readonly durationMin: number; readonly id: string };

export interface CarbEntry {
  readonly id: string;
  readonly date: Millis;
  readonly grams: number;
  /** Expected absorption time in hours (default 3). */
  readonly absorptionHours?: number;
}

/** A value that changes over the day; entries sorted by `startMinute` (minutes after local midnight). */
export interface ScheduleEntry<T = number> {
  readonly startMinute: number;
  readonly value: T;
}
export type Schedule<T = number> = readonly ScheduleEntry<T>[];

export interface TargetRange {
  readonly low: number;
  readonly high: number;
}

export type InsulinCurve = 'rapid-acting' | 'ultra-rapid';

export interface TherapyProfile {
  /** U/h */
  readonly basal: Schedule;
  /** mg/dL per U */
  readonly isf: Schedule;
  /** g per U */
  readonly carbRatio: Schedule;
  /** mg/dL */
  readonly target: Schedule<TargetRange>;
  /** Duration of insulin action in hours. */
  readonly diaHours: number;
  readonly insulinCurve: InsulinCurve;
  /** Override the curve's default peak (minutes). */
  readonly insulinPeakMinutes?: number;
  /** Minutes offset of the user's timezone from UTC (for schedule lookup). */
  readonly utcOffsetMinutes?: number;
}

/**
 * Hard limits that the SafetyGuard enforces regardless of which algorithm is active.
 * These are intentionally *not* algorithm settings.
 */
export interface SafetyLimits {
  /** U/h, absolute ceiling for any temp basal */
  readonly maxBasalRate: number;
  /** U, ceiling for any single bolus (manual or automatic) */
  readonly maxBolus: number;
  /** U, ceiling for total IOB after an automatic action */
  readonly maxIOB: number;
  /** U, ceiling for a single automatic (micro)bolus */
  readonly maxAutoBolus: number;
  /** mg/dL, below this no automatic insulin is ever added and a zero temp is set */
  readonly suspendThreshold: number;
  /** minutes, CGM data older than this stops automatic dosing */
  readonly maxGlucoseAgeMinutes: number;
  /** minutes, minimum spacing between automatic boluses */
  readonly minAutoBolusIntervalMinutes: number;
}

export interface TempBasalState {
  readonly rate: number;
  readonly startedAt: Millis;
  readonly durationMin: number;
}

export interface PumpState {
  readonly reservoirUnits: number | null;
  readonly batteryPercent: number | null;
  readonly suspended: boolean;
  readonly tempBasal: TempBasalState | null;
  readonly bolusing: boolean;
  /** Smallest deliverable bolus step, U */
  readonly bolusIncrement: number;
  /** Smallest temp basal step, U/h */
  readonly basalIncrement: number;
  readonly lastSync: Millis;
}

export interface IobSnapshot {
  readonly date: Millis;
  /** Net IOB relative to scheduled basal, U */
  readonly iob: number;
  /** Bolus-only IOB, U */
  readonly bolusIob: number;
  /** Net basal IOB, U */
  readonly basalIob: number;
  /** Insulin activity, U/min */
  readonly activity: number;
}

export interface Predictions {
  /** mg/dL every 5 min, index 0 == now */
  readonly iob?: readonly number[];
  readonly cob?: readonly number[];
  readonly uam?: readonly number[];
  readonly zt?: readonly number[];
  /** Single generic prediction for algorithms that only produce one line. */
  readonly main?: readonly number[];
}
