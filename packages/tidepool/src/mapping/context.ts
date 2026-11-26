import type { InsulinDose, Millis } from '@buddy/core';
import { md5Hex } from '../encoding';
import type { TidepoolFormulation, TidepoolOrigin } from '../types';

/** Tunables shared by all mappers. Everything but the client identity is optional. */
export interface MappingOptions {
  /** Identifies Buddy as the data source (`origin.name`) and the data set (`client.name`), e.g. `org.nightscout.Buddy`. */
  readonly clientName: string;
  /** Semantic version of the app (`origin.version`, `client.version`). */
  readonly clientVersion: string;
  /** Insulin brand sent with boluses and basals (`NovoLog`, `Humalog`, ...), as Trio takes it from the pump. */
  readonly insulinFormulation?: TidepoolFormulation;
  /** `deviceId` of the CGM and the pump, as Tidepool shows it. */
  readonly deviceIds?: { readonly cgm?: string; readonly pump?: string };
  /** Glucose `source` values that are fingersticks (uploaded as `smbg`). Default `['manual']`. */
  readonly manualGlucoseSources?: readonly string[];
  /** Programmed basal rate (U/h) at a time; becomes `suppressed` on temp basals and suspends. */
  readonly scheduledBasalAt?: (date: Millis) => number | null | undefined;
  /** Temp basals set by the loop are `automated` basals (Trio's default); return false for hand-set ones (`temp`). */
  readonly isAutomaticTempBasal?: (dose: Extract<InsulinDose, { kind: 'tempBasal' }>) => boolean;
  /** Why a suspend happened; Trio always reports `automatic`. */
  readonly suspendReason?: (dose: Extract<InsulinDose, { kind: 'suspend' }>) => 'manual' | 'automatic';
  /** Records that must not be uploaded; default skips ids of data read from Nightscout (`ns-` prefix). */
  readonly excludeId?: (id: string) => boolean;
}

export interface MappingContext extends MappingOptions {
  readonly userId: string;
}

/** Name of the one schedule Trio's TidepoolService writes (`StoredSettings.activeScheduleNameDefault`). */
export const ACTIVE_SCHEDULE_NAME = 'Default';

export const isExcluded = (ctx: MappingContext, id: string): boolean => (ctx.excludeId ? ctx.excludeId(id) : id.startsWith('ns-'));

export const originOf = (ctx: MappingContext, id: string): TidepoolOrigin => ({ id, name: ctx.clientName, version: ctx.clientVersion, type: 'application' });

/** `datumId`: `md5("<userId>:<resolvedIdentifier>")`. */
export const datumId = (ctx: MappingContext, resolvedIdentifier: string): string => md5Hex(`${ctx.userId}:${resolvedIdentifier}`);

/** Glucose and carbs (TidepoolService `IdentifiableHKDatum`): identity is the app plus the record's sync id. */
export const resolvedRecordId = (ctx: MappingContext, syncIdentifier: string): string =>
  md5Hex(`provenanceIdentifier:${ctx.clientName}:syncIdentifier:${syncIdentifier}`);

/** Doses, pump events and settings (TidepoolService `IdentifiableDatum`): `<md5(syncId)>:<datum type>`. */
export const resolvedTypedId = (syncIdentifier: string, typeName: string): string => `${md5Hex(syncIdentifier)}:${typeName}`;

/** The `type[/subtype]` strings TidepoolService appends to typed identifiers. */
export const DATUM_TYPES = {
  basalAutomated: 'basal/automated',
  basalScheduled: 'basal/scheduled',
  basalSuspend: 'basal/suspend',
  basalTemp: 'basal/temp',
  bolusAutomated: 'bolus/automated',
  bolusNormal: 'bolus/normal',
  insulin: 'insulin',
  deviceAlarm: 'deviceEvent/alarm',
  devicePrime: 'deviceEvent/prime',
  deviceReservoirChange: 'deviceEvent/reservoirChange',
  deviceStatus: 'deviceEvent/status',
  deviceTimeChange: 'deviceEvent/timeChange',
  pumpSettings: 'pumpSettings',
} as const;
