import type { ActiveOverride } from './adjustments';
import type { GlucoseStatus } from './glucose';
import type { SettingsSection, SettingsValues } from './settings-schema';
import type { CarbEntry, GlucoseReading, InsulinDose, IobSnapshot, Millis, Predictions, PumpState, SafetyLimits, TherapyProfile } from './types';

/** Everything an algorithm may look at. Immutable snapshot assembled by the LoopEngine. */
export interface AlgorithmInput {
  readonly now: Millis;
  /** Newest first, last 24 h */
  readonly glucose: readonly GlucoseReading[];
  readonly glucoseStatus: GlucoseStatus;
  /** Last 24 h of delivered insulin */
  readonly doses: readonly InsulinDose[];
  /** Last 24 h of carbs */
  readonly carbs: readonly CarbEntry[];
  readonly profile: TherapyProfile;
  readonly limits: SafetyLimits;
  readonly pump: PumpState;
  readonly iob: IobSnapshot;
  readonly cob: number;
  /** Optional temporary target override, mg/dL */
  readonly tempTarget?: { readonly low: number; readonly high: number; readonly endsAt: Millis; readonly startsAt?: Millis; readonly halfBasalTarget?: number };
  /** Active profile override (insulin needs %, target, SMB off). Use `effectiveSettings()`. */
  readonly override?: ActiveOverride;
}

export interface AlgorithmDecision {
  /** Temp basal to set. `null` = cancel any running temp. `undefined` = leave as is. */
  readonly tempBasal?: { readonly rate: number; readonly durationMin: number } | null;
  /** Automatic (micro)bolus in U. */
  readonly autoBolus?: number;
  readonly predictions?: Predictions;
  readonly eventualGlucose?: number;
  /** Insulin the algorithm thinks is required (informational), U */
  readonly insulinReq?: number;
  /** Carbs the algorithm suggests eating to avoid a low, g */
  readonly carbsReq?: number;
  readonly sensitivityRatio?: number;
  /** Human-readable explanation shown in the UI. */
  readonly reason: string;
  /** Free-form, algorithm-specific debug values shown in the developer panel. */
  readonly debug?: Readonly<Record<string, number | string | boolean>>;
}

export interface AlgorithmMeta {
  /** Stable kebab-case id, e.g. `oref-smb`. */
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly description: string;
  readonly version: string;
  readonly author: string;
  readonly capabilities: {
    readonly tempBasal: boolean;
    readonly autoBolus: boolean;
    readonly predictions: readonly (keyof Predictions)[];
  };
  /** `experimental` algorithms are only selectable when developer mode is on. */
  readonly maturity: 'reference' | 'experimental';
}

/**
 * The contract every dosing algorithm implements. Algorithms are pure: given an input
 * snapshot and settings they return a decision. They never talk to devices; the
 * LoopEngine enacts decisions after the SafetyGuard has clamped them.
 */
export interface AlgorithmPlugin<S extends SettingsValues = SettingsValues> {
  readonly meta: AlgorithmMeta;
  readonly settings: readonly SettingsSection[];
  readonly defaultSettings: S;
  decide(input: AlgorithmInput, settings: S): AlgorithmDecision;
}

/** Helper that preserves the settings type when declaring a plugin. */
export const defineAlgorithm = <S extends SettingsValues>(plugin: AlgorithmPlugin<S>): AlgorithmPlugin<S> => plugin;
