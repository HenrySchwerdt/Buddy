import { MINUTE } from '@buddy/core';
import { isoTime, round } from '../encoding';
import type { DeviceAlarmKind, DeviceEventDatum, MappedDatum, TidepoolAlarmType, TidepoolDeviceEvent } from '../types';
import { DATUM_TYPES, datumId, isExcluded, originOf, resolvedTypedId, type MappingContext } from './context';

const ALARMS: Readonly<Record<DeviceAlarmKind, TidepoolAlarmType>> = {
  autoOff: 'auto_off',
  lowInsulin: 'low_insulin',
  lowPower: 'low_power',
  noDelivery: 'no_delivery',
  noInsulin: 'no_insulin',
  noPower: 'no_power',
  occlusion: 'occlusion',
  overLimit: 'over_limit',
  other: 'other',
};

/** `yyyy-MM-ddTHH:mm:ss` wall-clock time at a fixed UTC offset (Tidepool `timeChange.from/to.time`). */
export function localTime(date: number, offsetMinutes: number): string {
  return new Date(date + offsetMinutes * MINUTE).toISOString().slice(0, 19);
}

const typeNameOf = (e: TidepoolDeviceEvent): string => {
  switch (e.kind) {
    case 'reservoirChange':
      return DATUM_TYPES.deviceReservoirChange;
    case 'prime':
      return DATUM_TYPES.devicePrime;
    case 'alarm':
      return DATUM_TYPES.deviceAlarm;
    case 'status':
      return DATUM_TYPES.deviceStatus;
    case 'timeChange':
      return DATUM_TYPES.deviceTimeChange;
  }
};

function body(e: TidepoolDeviceEvent): Record<string, unknown> {
  switch (e.kind) {
    case 'reservoirChange':
      return { subType: 'reservoirChange' };
    case 'prime':
      // TidepoolService defaults to `tubing` until it knows better.
      return { subType: 'prime', primeTarget: e.target ?? 'tubing', ...(e.volume !== undefined && e.volume > 0 ? { volume: round(e.volume, 3) } : {}) };
    case 'alarm':
      return { subType: 'alarm', alarmType: ALARMS[e.alarm] };
    case 'status':
      return { subType: 'status', status: e.name, reason: { [e.name]: e.reason ?? 'automatic' } };
    case 'timeChange':
      return {
        subType: 'timeChange',
        from: { time: localTime(e.date, e.fromOffsetMinutes) },
        to: { time: localTime(e.date, e.toOffsetMinutes) },
        method: e.method ?? 'manual',
      };
  }
}

export function mapDeviceEvent(e: TidepoolDeviceEvent, ctx: MappingContext): MappedDatum<DeviceEventDatum> | null {
  if (!Number.isFinite(e.date) || isExcluded(ctx, e.id)) return null;
  const resolved = resolvedTypedId(e.id, typeNameOf(e));
  const payload = { syncIdentifier: e.id, ...(e.kind === 'alarm' && e.alarm === 'other' && e.detail ? { otherAlarmType: e.detail } : {}) };
  const datum = {
    type: 'deviceEvent',
    ...body(e),
    time: isoTime(e.date),
    id: datumId(ctx, resolved),
    origin: originOf(ctx, resolved),
    payload,
    ...(ctx.deviceIds?.pump ? { deviceId: ctx.deviceIds.pump } : {}),
  } as unknown as DeviceEventDatum; // `body` supplies the sub-type fields of the union
  return { revisedAt: e.date, datum };
}

export const mapDeviceEvents = (events: readonly TidepoolDeviceEvent[], ctx: MappingContext): MappedDatum<DeviceEventDatum>[] =>
  events.flatMap((e) => {
    const m = mapDeviceEvent(e, ctx);
    return m ? [m] : [];
  });
