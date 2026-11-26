import { MINUTE, insulinModelFor, type Schedule } from '@buddy/core';
import { isoTime, md5Hex, round } from '../encoding';
import type { MappedDatum, PumpSettingsDatum, PumpSettingsSnapshot } from '../types';
import { ACTIVE_SCHEDULE_NAME, DATUM_TYPES, datumId, originOf, resolvedTypedId, type MappingContext } from './context';

/** Loop's exponential insulin presets (and so TidepoolService) assume 10 minutes before the insulin acts. */
export const INSULIN_ACTION_DELAY_SECONDS = 10 * 60;

const mgdl = (v: number): number => round(v, 3);

const schedule = <T, R>(s: Schedule<T>, f: (v: T) => R): ({ start: number } & R)[] =>
  s.map((e) => ({ start: e.startMinute * MINUTE, ...f(e.value) }));

export interface MappedPumpSettings extends MappedDatum<PumpSettingsDatum> {
  /** Hash of everything but the time; equal keys mean "nothing changed", so no new datum is needed. */
  readonly contentKey: string;
}

type Body = Omit<PumpSettingsDatum, 'time' | 'id' | 'origin' | 'payload'>;

function bodyOf(s: PumpSettingsSnapshot, ctx: MappingContext): Body {
  const model = insulinModelFor(s.profile);
  const offset = s.utcOffsetMinutes ?? s.profile.utcOffsetMinutes ?? 0;
  const pump = s.pump;
  return {
    type: 'pumpSettings',
    ...(s.timeZone ? { timezone: s.timeZone } : {}),
    timezoneOffset: offset,
    activeSchedule: ACTIVE_SCHEDULE_NAME,
    basal: { rateMaximum: { value: round(s.limits.maxBasalRate, 3), units: 'Units/hour' } },
    basalSchedules: { [ACTIVE_SCHEDULE_NAME]: schedule(s.profile.basal, (rate) => ({ rate: round(rate, 3) })) },
    ...(Number.isFinite(s.limits.suspendThreshold) ? { bgSafetyLimit: mgdl(s.limits.suspendThreshold) } : {}),
    bgTargets: { [ACTIVE_SCHEDULE_NAME]: schedule(s.profile.target, (t) => ({ low: mgdl(t.low), high: mgdl(t.high) })) },
    bolus: { amountMaximum: { value: round(s.limits.maxBolus, 3), units: 'Units' } },
    carbRatios: { [ACTIVE_SCHEDULE_NAME]: schedule(s.profile.carbRatio, (amount) => ({ amount: round(amount, 3) })) },
    display: { bloodGlucose: { units: s.glucoseUnit } },
    ...(ctx.insulinFormulation ? { insulinFormulation: ctx.insulinFormulation } : {}),
    insulinModel: {
      modelType: s.profile.insulinCurve === 'ultra-rapid' ? 'fiasp' : 'rapidAdult',
      actionDelay: INSULIN_ACTION_DELAY_SECONDS,
      actionDuration: Math.round(model.diaMinutes * 60),
      actionPeakOffset: Math.round(model.peakMinutes * 60),
    },
    insulinSensitivities: { [ACTIVE_SCHEDULE_NAME]: schedule(s.profile.isf, (amount) => ({ amount: mgdl(amount) })) },
    units: { bg: 'mg/dL', carb: 'grams', insulin: 'Units' },
    ...(pump?.manufacturer ? { manufacturers: [pump.manufacturer] } : {}),
    ...(pump?.model ? { model: pump.model } : {}),
    ...(pump?.name ? { name: pump.name } : {}),
    ...(pump?.firmwareVersion ? { firmwareVersion: pump.firmwareVersion } : {}),
    ...(pump?.hardwareVersion ? { hardwareVersion: pump.hardwareVersion } : {}),
    ...(pump?.softwareVersion ? { softwareVersion: pump.softwareVersion } : {}),
  };
}

/**
 * Therapy profile and limits as one `pumpSettings` datum, with the schedules under
 * `Default` like TidepoolService. All glucose-based values are mg/dL.
 */
export function mapPumpSettings(s: PumpSettingsSnapshot, ctx: MappingContext): MappedPumpSettings {
  const body = bodyOf(s, ctx);
  const contentKey = md5Hex(JSON.stringify(body));
  const resolved = resolvedTypedId(contentKey, DATUM_TYPES.pumpSettings);
  const datum: PumpSettingsDatum = {
    ...body,
    time: isoTime(s.date),
    id: datumId(ctx, resolved),
    origin: originOf(ctx, resolved),
    payload: { syncIdentifier: contentKey },
    ...(ctx.deviceIds?.pump ? { deviceId: ctx.deviceIds.pump } : {}),
  };
  return { datum, revisedAt: s.date, contentKey };
}
