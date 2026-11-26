import { MINUTE, isExternalDose, type InsulinDose, type Millis } from '@buddy/core';
import type { TidepoolSelector } from '../api';
import { isoTime, round } from '../encoding';
import type { BasalDatum, BolusDatum, DeviceEventDatum, InsulinDatum, MappedDatum, ScheduledBasalSegment, SuppressedScheduledBasal } from '../types';
import { ACTIVE_SCHEDULE_NAME, DATUM_TYPES, datumId, isExcluded, originOf, resolvedTypedId, type MappingContext } from './context';

const INSULIN_PLACES = 3;
const MS_PER_HOUR = 60 * MINUTE;

type Bolus = Extract<InsulinDose, { kind: 'bolus' | 'smb' }>;
type TempBasal = Extract<InsulinDose, { kind: 'tempBasal' }>;
type Suspend = Extract<InsulinDose, { kind: 'suspend' }>;

const typed = (ctx: MappingContext, syncId: string, typeName: string) => {
  const resolved = resolvedTypedId(syncId, typeName);
  return { id: datumId(ctx, resolved), origin: originOf(ctx, resolved) };
};

const isAutomaticTemp = (ctx: MappingContext, dose: TempBasal): boolean => (ctx.isAutomaticTempBasal ? ctx.isAutomaticTempBasal(dose) : true);

function tempBasalType(ctx: MappingContext, dose: TempBasal): string {
  return isAutomaticTemp(ctx, dose) ? DATUM_TYPES.basalAutomated : DATUM_TYPES.basalTemp;
}

/** Bolus kinds as TidepoolService maps `DoseEntry`: external = `insulin`, SMB = `automated`, otherwise `normal`. */
function bolusType(dose: Bolus): string {
  if (isExternalDose(dose)) return DATUM_TYPES.insulin;
  return dose.kind === 'smb' ? DATUM_TYPES.bolusAutomated : DATUM_TYPES.bolusNormal;
}

function mapBolus(dose: Bolus, ctx: MappingContext): MappedDatum<BolusDatum | InsulinDatum> | null {
  if (!Number.isFinite(dose.units) || dose.units <= 0) return null;
  const units = round(dose.units, INSULIN_PLACES);
  const common = {
    time: isoTime(dose.date),
    payload: { syncIdentifier: dose.id, duration: 0 },
    ...(ctx.deviceIds?.pump ? { deviceId: ctx.deviceIds.pump } : {}),
  };
  const type = bolusType(dose);
  const ids = typed(ctx, dose.id, type);
  if (type === DATUM_TYPES.insulin) {
    // Never delivered by the pump, so no pump insulin brand either (Trio sends none).
    return { revisedAt: dose.date, datum: { ...common, ...ids, type: 'insulin', dose: { total: units, units: 'Units' } } };
  }
  const formulation = ctx.insulinFormulation ? { insulinFormulation: ctx.insulinFormulation } : {};
  return {
    revisedAt: dose.date,
    datum: { ...common, ...ids, type: 'bolus', subType: type === DATUM_TYPES.bolusAutomated ? 'automated' : 'normal', normal: units, ...formulation },
  };
}

const suppressedAt = (ctx: MappingContext, date: Millis): { suppressed: SuppressedScheduledBasal } | Record<string, never> => {
  const rate = ctx.scheduledBasalAt?.(date);
  if (rate === undefined || rate === null || !Number.isFinite(rate)) return {};
  return { suppressed: { type: 'basal', deliveryType: 'scheduled', rate: round(rate, INSULIN_PLACES), scheduleName: ACTIVE_SCHEDULE_NAME } };
};

/**
 * Temp basals and suspends run until their programmed end or until the next basal event starts,
 * whichever is first (the same rule as the IOB calculation). A shortened one is sent with the real
 * `duration` and its programmed length as `expectedDuration` (Tidepool's way to say "cut short"),
 * and counts as revised at the moment the next event started.
 */
function basalTimes(dose: TempBasal | Suspend, next: InsulinDose | undefined): { duration: number; expectedDuration?: number; revisedAt: Millis; open: boolean } {
  const programmed = Math.max(0, dose.durationMin) * MINUTE;
  if (programmed === 0) {
    // Suspend without a known end: open until the next basal event, if any.
    return next ? { duration: next.date - dose.date, revisedAt: next.date, open: false } : { duration: 0, revisedAt: dose.date, open: true };
  }
  if (next && next.date < dose.date + programmed) {
    return { duration: next.date - dose.date, expectedDuration: programmed, revisedAt: next.date, open: false };
  }
  return { duration: programmed, revisedAt: dose.date, open: false };
}

function mapTempBasal(dose: TempBasal, next: InsulinDose | undefined, ctx: MappingContext): MappedDatum<BasalDatum> | null {
  // Duration 0 only cancels the running temp; it ends the previous basal (see `basalTimes`) and has no datum of its own.
  if (!(dose.durationMin > 0) || !Number.isFinite(dose.rate) || dose.rate < 0) return null;
  const t = basalTimes(dose, next);
  const automatic = isAutomaticTemp(ctx, dose);
  const delivered = round((dose.rate * t.duration) / MS_PER_HOUR, INSULIN_PLACES);
  return {
    revisedAt: t.revisedAt,
    datum: {
      type: 'basal',
      deliveryType: automatic ? 'automated' : 'temp',
      time: isoTime(dose.date),
      duration: t.duration,
      ...(t.expectedDuration !== undefined ? { expectedDuration: t.expectedDuration } : {}),
      rate: round(dose.rate, INSULIN_PLACES),
      ...(automatic ? { scheduleName: ACTIVE_SCHEDULE_NAME } : {}),
      ...(ctx.insulinFormulation ? { insulinFormulation: ctx.insulinFormulation } : {}),
      ...suppressedAt(ctx, dose.date),
      ...typed(ctx, dose.id, tempBasalType(ctx, dose)),
      payload: { syncIdentifier: dose.id, deliveredUnits: delivered },
      ...(ctx.deviceIds?.pump ? { deviceId: ctx.deviceIds.pump } : {}),
    },
  };
}

function statusEvent(
  dose: Suspend,
  ctx: MappingContext,
  name: 'suspended' | 'resumed',
  date: Millis,
  reason: 'manual' | 'automatic',
): MappedDatum<DeviceEventDatum> {
  return {
    revisedAt: date,
    datum: {
      type: 'deviceEvent',
      subType: 'status',
      status: name,
      reason: { [name]: reason },
      time: isoTime(date),
      ...typed(ctx, `${dose.id}:${name}`, DATUM_TYPES.deviceStatus),
      payload: { syncIdentifier: `${dose.id}:${name}` },
      ...(ctx.deviceIds?.pump ? { deviceId: ctx.deviceIds.pump } : {}),
    },
  };
}

/** A suspend becomes the `basal/suspend` datum plus `suspended` / `resumed` status events (TidepoolService does both). */
function mapSuspend(dose: Suspend, next: InsulinDose | undefined, ctx: MappingContext): MappedDatum[] {
  const t = basalTimes(dose, next);
  const reason = ctx.suspendReason ? ctx.suspendReason(dose) : 'automatic';
  const basal: MappedDatum<BasalDatum> = {
    revisedAt: t.revisedAt,
    datum: {
      type: 'basal',
      deliveryType: 'suspend',
      time: isoTime(dose.date),
      duration: t.duration,
      ...(t.expectedDuration !== undefined ? { expectedDuration: t.expectedDuration } : {}),
      ...suppressedAt(ctx, dose.date),
      // Like Trio's mutable doses: a suspend with no known end is flagged, not given a made-up duration.
      ...(t.open ? { annotations: [{ code: 'basal/unknown-duration' }] } : {}),
      ...typed(ctx, dose.id, DATUM_TYPES.basalSuspend),
      payload: { syncIdentifier: dose.id },
      ...(ctx.deviceIds?.pump ? { deviceId: ctx.deviceIds.pump } : {}),
    },
  };
  const events = [statusEvent(dose, ctx, 'suspended', dose.date, reason)];
  if (t.duration > 0) events.push(statusEvent(dose, ctx, 'resumed', dose.date + t.duration, reason));
  return [basal, ...events];
}

/**
 * All dose data for `doses`. Pass the whole recent history, not just new doses: a temp basal
 * that a later dose cut short is returned again (same ids, new `duration`) so Tidepool replaces it.
 */
export function mapDoses(doses: readonly InsulinDose[], ctx: MappingContext): MappedDatum[] {
  const usable = doses.filter((d) => Number.isFinite(d.date) && !isExcluded(ctx, d.id));
  const basalEvents = usable.filter((d): d is TempBasal | Suspend => d.kind === 'tempBasal' || d.kind === 'suspend').sort((a, b) => a.date - b.date);
  const out: MappedDatum[] = [];
  for (const dose of usable) {
    if (dose.kind === 'tempBasal') {
      const m = mapTempBasal(dose, basalEvents.find((e) => e.date > dose.date), ctx);
      if (m) out.push(m);
    } else if (dose.kind === 'suspend') {
      out.push(...mapSuspend(dose, basalEvents.find((e) => e.date > dose.date), ctx));
    } else {
      const m = mapBolus(dose, ctx);
      if (m) out.push(m);
    }
  }
  return out;
}

export function mapScheduledBasal(segments: readonly ScheduledBasalSegment[], ctx: MappingContext): MappedDatum<BasalDatum>[] {
  return segments.flatMap((s) => {
    if (!(s.durationMin > 0) || !(s.rate >= 0) || !Number.isFinite(s.date) || isExcluded(ctx, s.id)) return [];
    const duration = s.durationMin * MINUTE;
    const datum: BasalDatum = {
      type: 'basal',
      deliveryType: 'scheduled',
      time: isoTime(s.date),
      duration,
      rate: round(s.rate, INSULIN_PLACES),
      scheduleName: ACTIVE_SCHEDULE_NAME,
      ...(ctx.insulinFormulation ? { insulinFormulation: ctx.insulinFormulation } : {}),
      ...typed(ctx, s.id, DATUM_TYPES.basalScheduled),
      payload: { syncIdentifier: s.id, deliveredUnits: round((s.rate * duration) / MS_PER_HOUR, INSULIN_PLACES) },
      ...(ctx.deviceIds?.pump ? { deviceId: ctx.deviceIds.pump } : {}),
    };
    return [{ revisedAt: s.date, datum }];
  });
}

/** Selectors (by `origin.id`) of the data `mapDoses` produced for `dose`, for deleting it from Tidepool. */
export function doseSelectors(dose: InsulinDose, ctx: MappingContext): TidepoolSelector[] {
  const sel = (type: string): TidepoolSelector => ({ origin: { id: resolvedTypedId(dose.id, type) } });
  switch (dose.kind) {
    case 'bolus':
    case 'smb':
      return [sel(bolusType(dose))];
    case 'tempBasal':
      return [sel(tempBasalType(ctx, dose))];
    case 'suspend':
      return [sel(DATUM_TYPES.basalSuspend)];
  }
}
