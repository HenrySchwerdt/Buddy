import type { ActiveOverride, ActiveTempTarget, CarbEntry, InsulinDose, Millis } from '@buddy/core';
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

export function mapDoseToTreatments(dose: InsulinDose): NightscoutTreatmentDoc[] {
  switch (dose.kind) {
    case 'bolus':
    case 'smb':
      return [{ ...base(dose.kind === 'smb' ? 'SMB' : 'Bolus', dose.date, dose.id), insulin: round(dose.units, INSULIN_PLACES) }];
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
    ...(carb.note ? { notes: carb.note } : {}),
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
