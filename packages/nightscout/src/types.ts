/**
 * JSON documents as Buddy uploads them to the Nightscout v1 API. Field names follow Trio's
 * `NightscoutTreatment`, `NightscoutExercise`, `BloodGlucose` and `NightscoutStatus` encodings,
 * so Nightscout and its followers render Buddy data exactly like Trio data.
 */

/** `api/v1/entries.json` */
export interface NightscoutEntry {
  readonly type: 'sgv';
  /** mg/dL, integer */
  readonly sgv: number;
  readonly direction?: string;
  /** epoch ms */
  readonly date: number;
  readonly dateString: string;
  readonly noise?: number;
  readonly device: string;
  /** Stable Buddy-side dedupe key. */
  readonly identifier: string;
}

export type TreatmentEventType =
  | 'Bolus'
  | 'SMB'
  | 'External Insulin'
  | 'Temp Basal'
  | 'Carb Correction'
  | 'Temporary Target'
  | 'Exercise'
  | 'Note';

/** `api/v1/treatments.json` */
export interface NightscoutTreatmentDoc {
  readonly eventType: TreatmentEventType;
  readonly created_at: string;
  readonly enteredBy: string;
  /** Stable Buddy-side dedupe key (the Buddy record id). */
  readonly identifier: string;
  /** Same value as `identifier`; Trio sends its record id as `id`. */
  readonly id: string;
  readonly insulin?: number;
  /** minutes */
  readonly duration?: number;
  /** U/h */
  readonly absolute?: number;
  /** U/h */
  readonly rate?: number;
  readonly carbs?: number;
  readonly fat?: number;
  readonly protein?: number;
  /** minutes (Loop/AAPS convention; Trio omits it) */
  readonly absorptionTime?: number;
  readonly notes?: string;
  /** mg/dL */
  readonly targetTop?: number;
  /** mg/dL */
  readonly targetBottom?: number;
  readonly units?: 'mg/dl';
}

/** oref `Determination` as found in `openaps.suggested` / `openaps.enacted`. */
export interface NightscoutDetermination {
  readonly reason: string;
  readonly timestamp: string;
  readonly deliverAt: string;
  readonly bg?: number;
  readonly IOB?: number;
  readonly COB?: number;
  readonly eventualBG?: number;
  readonly insulinReq?: number;
  readonly carbsReq?: number;
  readonly sensitivityRatio?: number;
  /** U/h; 0 with duration 0 = cancel temp */
  readonly rate?: number;
  readonly duration?: number;
  /** Automatic bolus, U */
  readonly units?: number;
  readonly predBGs?: { readonly IOB?: number[]; readonly ZT?: number[]; readonly COB?: number[]; readonly UAM?: number[] };
  /** Enacted only: the pump confirmed the command. */
  readonly received?: boolean;
}

/** `api/v1/devicestatus.json` */
export interface NightscoutDeviceStatus {
  readonly device: string;
  readonly created_at: string;
  readonly openaps: {
    readonly iob: { readonly iob: number; readonly time: string };
    readonly suggested?: NightscoutDetermination;
    readonly enacted?: NightscoutDetermination;
    readonly version: string;
    readonly dosingMode: string;
  };
  readonly pump?: {
    readonly clock: string;
    readonly reservoir?: number;
    readonly battery?: { readonly percent: number };
    readonly status: { readonly status: 'normal' | 'suspended' | 'bolusing'; readonly bolusing: boolean; readonly suspended: boolean; readonly timestamp: string };
    readonly bolusIncrement: number;
  };
  readonly uploader?: { readonly battery: number; readonly isCharging?: boolean };
}

/** Phone/uploader details for devicestatus (not part of Buddy's loop data). */
export interface DeviceStatusOptions {
  /** App version shown in Nightscout's loop pill. */
  readonly version?: string;
  /** Phone battery in percent. */
  readonly uploaderBattery?: number;
  readonly isCharging?: boolean;
}
