import type { GlucoseUnit, Millis, SafetyLimits, TherapyProfile } from '@buddy/core';

/** `time` and friends: ISO 8601 UTC with milliseconds. */
export type TidepoolTime = string;

export interface TidepoolOrigin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly type: 'application';
}

export interface TidepoolFormulation {
  readonly name?: string;
  readonly simple?: {
    readonly actingType?: 'rapid' | 'short' | 'intermediate' | 'long';
    readonly brand?: string;
    readonly concentration?: { readonly value: number; readonly units: 'Units/mL' };
  };
}

/** Fields shared by every datum Buddy writes (TidepoolKit `TDatum`; `uploadId` comes from the URL). */
interface DatumBase {
  readonly time: TidepoolTime;
  /** MD5 of `userId:resolvedIdentifier`, stable across uploads so a re-sent datum is the same datum. */
  readonly id: string;
  readonly origin: TidepoolOrigin;
  readonly deviceId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly annotations?: readonly Readonly<Record<string, unknown>>[];
  readonly notes?: readonly string[];
}

export type TidepoolTrend = 'constant' | 'slowFall' | 'slowRise' | 'moderateFall' | 'moderateRise' | 'rapidFall' | 'rapidRise';

export interface CbgDatum extends DatumBase {
  readonly type: 'cbg';
  readonly value: number;
  readonly units: 'mg/dL';
  readonly trend?: TidepoolTrend;
}

export interface SmbgDatum extends DatumBase {
  readonly type: 'smbg';
  readonly subType: 'manual';
  readonly value: number;
  readonly units: 'mg/dL';
}

export interface BolusDatum extends DatumBase {
  readonly type: 'bolus';
  readonly subType: 'normal' | 'automated';
  readonly normal: number;
  readonly expectedNormal?: number;
  readonly insulinFormulation?: TidepoolFormulation;
}

/** Insulin the user injected outside the pump (Trio's external insulin). */
export interface InsulinDatum extends DatumBase {
  readonly type: 'insulin';
  readonly dose: { readonly total: number; readonly units: 'Units' };
  readonly formulation?: TidepoolFormulation;
}

export interface SuppressedScheduledBasal {
  readonly type: 'basal';
  readonly deliveryType: 'scheduled';
  readonly rate: number;
  readonly scheduleName?: string;
}

export interface BasalDatum extends DatumBase {
  readonly type: 'basal';
  readonly deliveryType: 'automated' | 'scheduled' | 'temp' | 'suspend';
  /** Milliseconds. */
  readonly duration: number;
  /** Milliseconds; present when the basal was cut short. */
  readonly expectedDuration?: number;
  readonly rate?: number;
  readonly scheduleName?: string;
  readonly insulinFormulation?: TidepoolFormulation;
  readonly suppressed?: SuppressedScheduledBasal;
}

export interface FoodDatum extends DatumBase {
  readonly type: 'food';
  readonly name?: string;
  readonly nutrition: {
    readonly carbohydrate: { readonly net: number; readonly units: 'grams' };
    readonly fat?: { readonly total: number; readonly units: 'grams' };
    readonly protein?: { readonly total: number; readonly units: 'grams' };
    /** Seconds. */
    readonly estimatedAbsorptionDuration?: number;
  };
}

export type TidepoolAlarmType = 'auto_off' | 'low_insulin' | 'low_power' | 'no_delivery' | 'no_insulin' | 'no_power' | 'occlusion' | 'other' | 'over_limit';

export type DeviceEventDatum = DatumBase & { readonly type: 'deviceEvent' } & (
    | { readonly subType: 'reservoirChange' }
    | { readonly subType: 'prime'; readonly primeTarget?: 'tubing' | 'cannula'; readonly volume?: number }
    | { readonly subType: 'alarm'; readonly alarmType: TidepoolAlarmType }
    | { readonly subType: 'status'; readonly status: 'suspended' | 'resumed'; readonly reason?: Readonly<Record<string, string>> }
    | { readonly subType: 'timeChange'; readonly from: { readonly time: string }; readonly to: { readonly time: string }; readonly method: 'manual' | 'automatic' }
  );

export interface ScheduleStart {
  /** Milliseconds after local midnight. */
  readonly start: number;
}

export interface PumpSettingsDatum extends DatumBase {
  readonly type: 'pumpSettings';
  readonly timezone?: string;
  /** Minutes east of UTC. */
  readonly timezoneOffset?: number;
  readonly activeSchedule: string;
  readonly basal: { readonly rateMaximum: { readonly value: number; readonly units: 'Units/hour' } };
  readonly basalSchedules: Readonly<Record<string, readonly (ScheduleStart & { readonly rate: number })[]>>;
  readonly bgSafetyLimit?: number;
  readonly bgTargets: Readonly<Record<string, readonly (ScheduleStart & { readonly low: number; readonly high: number })[]>>;
  readonly bolus: { readonly amountMaximum: { readonly value: number; readonly units: 'Units' } };
  readonly carbRatios: Readonly<Record<string, readonly (ScheduleStart & { readonly amount: number })[]>>;
  readonly display: { readonly bloodGlucose: { readonly units: 'mg/dL' | 'mmol/L' } };
  readonly insulinFormulation?: TidepoolFormulation;
  readonly insulinModel: {
    readonly modelType: 'rapidAdult' | 'fiasp';
    /** Seconds. */
    readonly actionDelay: number;
    readonly actionDuration: number;
    readonly actionPeakOffset: number;
  };
  readonly insulinSensitivities: Readonly<Record<string, readonly (ScheduleStart & { readonly amount: number })[]>>;
  readonly units: { readonly bg: 'mg/dL'; readonly carb: 'grams'; readonly insulin: 'Units' };
  readonly manufacturers?: readonly string[];
  readonly model?: string;
  readonly name?: string;
  readonly firmwareVersion?: string;
  readonly hardwareVersion?: string;
  readonly softwareVersion?: string;
}

export type TidepoolDatum = CbgDatum | SmbgDatum | BolusDatum | InsulinDatum | BasalDatum | FoodDatum | DeviceEventDatum | PumpSettingsDatum;

/** A datum plus the time it last changed; the uploader's high-water marks compare against `revisedAt`. */
export interface MappedDatum<D extends TidepoolDatum = TidepoolDatum> {
  readonly datum: D;
  readonly revisedAt: Millis;
}

// ── Inputs that have no counterpart in @buddy/core ─────────────────────────────

export type DeviceAlarmKind = 'autoOff' | 'lowInsulin' | 'lowPower' | 'noDelivery' | 'noInsulin' | 'noPower' | 'occlusion' | 'overLimit' | 'other';

/** Pump events that are not doses. `id` must be unique and stable (it becomes the datum id). */
export type TidepoolDeviceEvent =
  | { readonly kind: 'reservoirChange'; readonly id: string; readonly date: Millis }
  | { readonly kind: 'prime'; readonly id: string; readonly date: Millis; readonly target?: 'tubing' | 'cannula'; readonly volume?: number }
  | { readonly kind: 'alarm'; readonly id: string; readonly date: Millis; readonly alarm: DeviceAlarmKind; /** Free text for `other`. */ readonly detail?: string }
  | { readonly kind: 'status'; readonly id: string; readonly date: Millis; readonly name: 'suspended' | 'resumed'; readonly reason?: 'manual' | 'automatic' }
  | {
      readonly kind: 'timeChange';
      readonly id: string;
      readonly date: Millis;
      /** UTC offsets in minutes before and after the change. */
      readonly fromOffsetMinutes: number;
      readonly toOffsetMinutes: number;
      readonly method?: 'manual' | 'automatic';
    };

/** A stretch of the programmed basal profile that ran unmodified (Tidepool `basal/scheduled`). */
export interface ScheduledBasalSegment {
  readonly id: string;
  readonly date: Millis;
  readonly durationMin: number;
  /** U/h */
  readonly rate: number;
}

export interface PumpDeviceInfo {
  readonly manufacturer?: string;
  readonly model?: string;
  readonly name?: string;
  readonly firmwareVersion?: string;
  readonly hardwareVersion?: string;
  readonly softwareVersion?: string;
}

/** Everything Tidepool's `pumpSettings` datum records. Uploaded again only when its content changes. */
export interface PumpSettingsSnapshot {
  readonly date: Millis;
  readonly profile: TherapyProfile;
  readonly limits: Pick<SafetyLimits, 'maxBasalRate' | 'maxBolus' | 'suspendThreshold'>;
  /** The unit the app displays; schedules are always sent in mg/dL. */
  readonly glucoseUnit: GlucoseUnit;
  /** Fixed offset used for the schedules, minutes east of UTC. Defaults to `profile.utcOffsetMinutes ?? 0`. */
  readonly utcOffsetMinutes?: number;
  /** IANA name such as `Europe/Berlin`, when known. */
  readonly timeZone?: string;
  readonly pump?: PumpDeviceInfo;
}
