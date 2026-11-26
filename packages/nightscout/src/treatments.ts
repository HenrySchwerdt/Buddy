import { isExternalDose, type ActiveOverride, type ActiveTempTarget, type CarbEntry, type InsulinDose, type Millis } from '@buddy/core';
import { ENTERED_BY, isNightscoutId, isoDate, round } from './format';
import type { NightscoutTreatmentDoc, TreatmentEventType } from './types';

const MINUTE = 60_000;
/** Trio uploads indefinite overrides with a 30-day duration (OverrideStorage). */
export const INDEFINITE_OVERRIDE_MIN = 43_200;
const INSULIN_PLACES = 3;
const RATE_PLACES = 3;

const base = (eventType: TreatmentEventType, date: Millis, identifier: string) => ({
  eventType,
  created_at: isoDate(date),
  enteredBy: ENTERED_BY,
  identifier,
  id: identifier,
});

/**
 * Trio (PumpHistoryStorage) uploads suspend and resume as `Note` treatments whose notes are
 * the pump event names. A suspend with a known duration also yields its resume note.
 */
function suspendNotes(dose: Extract<InsulinDose, { kind: 'suspend' }>): NightscoutTreatmentDoc[] {
  const suspend: NightscoutTreatmentDoc = { ...base('Note', dose.date, dose.id), notes: 'PumpSuspend' };
  if (!(dose.durationMin > 0)) return [suspend];
  const resume: NightscoutTreatmentDoc = { ...base('Note', dose.date + dose.durationMin * MINUTE, `${dose.id}-resume`), notes: 'PumpResume' };
  return [suspend, resume];
}

/** Trio's `determineBolusEventType`: SMB first, then external, otherwise a normal Bolus. */
function bolusEventType(dose: Extract<InsulinDose, { kind: 'bolus' | 'smb' }>): TreatmentEventType {
  if (dose.kind === 'smb') return 'SMB';
  return isExternalDose(dose) ? 'External Insulin' : 'Bolus';
}

export function mapDoseToTreatments(dose: InsulinDose): NightscoutTreatmentDoc[] {
  switch (dose.kind) {
    case 'bolus':
    case 'smb':
      return [{ ...base(bolusEventType(dose), dose.date, dose.id), insulin: round(dose.units, INSULIN_PLACES) }];
    case 'tempBasal': {
      // Like Trio: absolute rate in both `absolute` and `rate`; duration 0 ends the running temp.
      const rate = round(dose.rate, RATE_PLACES);
      return [{ ...base('Temp Basal', dose.date, dose.id), duration: Math.max(0, Math.round(dose.durationMin)), absolute: rate, rate }];
    }
    case 'suspend':
      return suspendNotes(dose);
  }
}

/** Doses read from Nightscout (shadow mode, id `ns-…`) are skipped so they never loop back. */
export const mapDosesToTreatments = (doses: readonly InsulinDose[]): NightscoutTreatmentDoc[] =>
  doses.filter((d) => !isNightscoutId(d.id)).flatMap(mapDoseToTreatments);

/** Optional macros, sent like Trio's CarbsStorage when present. */
export interface CarbMacros {
  readonly fat?: number;
  readonly protein?: number;
  readonly note?: string;
}

export function mapCarbToTreatment(carb: CarbEntry & CarbMacros): NightscoutTreatmentDoc {
  return {
    ...base('Carb Correction', carb.date, carb.id),
    carbs: round(carb.grams, 1),
    ...(carb.fat !== undefined ? { fat: round(carb.fat, 1) } : {}),
    ...(carb.protein !== undefined ? { protein: round(carb.protein, 1) } : {}),
    ...(carb.absorptionHours !== undefined ? { absorptionTime: Math.round(carb.absorptionHours * 60) } : {}),
    // Trio's CarbsStorage sends the note twice: as `notes` and as `foodType`.
    ...(carb.note ? { notes: carb.note, foodType: carb.note } : {}),
  };
}

export const mapCarbsToTreatments = (carbs: readonly (CarbEntry & CarbMacros)[]): NightscoutTreatmentDoc[] =>
  carbs.filter((c) => !isNightscoutId(c.id)).map(mapCarbToTreatment);

/** Activations are keyed by preset id + start, since presets are reused. */
const activationId = (prefix: string, presetId: string, startedAt: Millis) => `${prefix}-${presetId}-${startedAt}`;

/** Trio: `Temporary Target`, top = bottom = target (mg/dL), notes = preset name. */
export function mapTempTargetToTreatment(t: ActiveTempTarget): NightscoutTreatmentDoc {
  return {
    ...base('Temporary Target', t.startedAt, activationId('tt', t.id, t.startedAt)),
    duration: Math.max(0, Math.round(t.durationMin)),
    targetTop: t.target,
    targetBottom: t.target,
    units: 'mg/dl',
    notes: t.name,
  };
}

/** Trio (`NightscoutExercise`): overrides go up as `Exercise` with the override name as notes. */
export function mapOverrideToTreatment(o: ActiveOverride): NightscoutTreatmentDoc {
  return {
    ...base('Exercise', o.startedAt, activationId('override', o.id, o.startedAt)),
    duration: o.durationMin === null ? INDEFINITE_OVERRIDE_MIN : Math.max(0, Math.round(o.durationMin)),
    notes: o.name,
  };
}

/** A CGM sensor session start, as the CGM driver reports it (Trio `BloodGlucose.sessionStartDate` etc.). */
export interface SensorSession {
  /** Session start; becomes the treatment time. */
  readonly startedAt: Millis;
  readonly transmitterId?: string;
  readonly activatedAt?: Millis;
}

/** Trio drops a session start within a minute of the previous one (GlucoseStorage.storeCGMState). */
const SENSOR_DEDUPE_MS = 60_000;

/** Swift's `Date.description`: `2026-11-25 12:00:00 +0000`. */
const swiftDateText = (t: Millis): string => `${new Date(t).toISOString().slice(0, 19).replace('T', ' ')} +0000`;

/** Trio `createCGMStateNotes`: "<transmitter> activated on <date>". */
export function sensorNotes(s: SensorSession): string {
  let notes = s.transmitterId ?? '';
  if (s.activatedAt !== undefined) notes = `${notes} activated on ${swiftDateText(s.activatedAt)}`;
  return notes;
}

/** Trio `createCGMStateTreatment`: a `Sensor Start` treatment whose notes identify the transmitter. */
export function mapSensorStartToTreatment(s: SensorSession): NightscoutTreatmentDoc {
  return { ...base('Sensor Start', s.startedAt, `sensor-${s.startedAt}`), notes: sensorNotes(s) };
}

export function mapSensorStartsToTreatments(sessions: readonly SensorSession[]): NightscoutTreatmentDoc[] {
  const out: NightscoutTreatmentDoc[] = [];
  let last: Millis | undefined;
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
    if (last !== undefined && Math.abs(s.startedAt - last) < SENSOR_DEDUPE_MS) continue;
    last = s.startedAt;
    out.push(mapSensorStartToTreatment(s));
  }
  return out;
}

/** Trio `uploadNoteTreatment`: a free-text `Note` treatment stamped with the current time. */
export const mapNoteToTreatment = (note: string, date: Millis): NightscoutTreatmentDoc => ({ ...base('Note', date, `note-${date}`), notes: note });
