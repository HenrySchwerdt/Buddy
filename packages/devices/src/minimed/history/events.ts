/**
 * Pump history records: TypeScript port of the `*PumpEvent.swift` files, `Models/HistoryPage.swift`
 * and `PumpManager/HistoryPage+PumpOpsSession.swift` (`timestampedEvents`) of MinimedKit (migrated
 * from ps2/rileylink_ios, MIT License, (c) LoopKit Authors).
 *
 * Fully decoded: bolus, temp basal (rate and duration), suspend, resume, prime, rewind, pump and
 * cleared alarms, basal profile start, unabsorbed insulin, change time / new time. Every other
 * record is walked by its length and kept as `other` (name and timestamp only), exactly the
 * information the Swift driver ignores as well.
 */
import type { Bytes } from '@buddy/core';
import { hex } from '@buddy/core';
import type { PumpClock } from '../messages/bodies';
import { appendsSquareWaveOnStart, bolusDeliveryTimeMs, insulinBitPackingScale, isLargerModel, type PumpModel } from '../models';
import { checkCrc16 } from './crc16';
import { eventLayout, EventType } from './event-table';

const u16be = (b: Bytes, o: number): number => (b[o]! << 8) | b[o + 1]!;

/** `DateComponents(pumpEventData:offset:)` for the 5 byte timestamp of a record. */
export function pumpEventTimestamp(data: Bytes, offset: number): PumpClock {
  const b = (i: number) => data[offset + i]!;
  return {
    second: b(0) & 0b00111111,
    minute: b(1) & 0b00111111,
    hour: b(2) & 0b00011111,
    day: b(3) & 0b00011111,
    month: ((b(0) & 0b11000000) >> 4) + ((b(1) & 0b11000000) >> 6),
    year: (b(4) & 0b01111111) + 2000,
  };
}

/** Inverse of {@link pumpEventTimestamp}; used by the simulator. */
export function encodePumpEventTimestamp(c: PumpClock): Bytes {
  return Uint8Array.of(
    (c.second & 0b00111111) | ((c.month & 0b1100) << 4),
    (c.minute & 0b00111111) | ((c.month & 0b0011) << 6),
    c.hour & 0b00011111,
    c.day & 0b00011111,
    (c.year - 2000) & 0b01111111,
  );
}

/** Milliseconds since the epoch of a pump wall-clock time, for a pump whose clock runs `utcOffsetSeconds` ahead of UTC. */
export const pumpClockToMillis = (c: PumpClock, utcOffsetSeconds: number): number => Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - utcOffsetSeconds * 1000;

/** The pump wall-clock time that shows at `millis` on a pump whose clock runs `utcOffsetSeconds` ahead of UTC. */
export function millisToPumpClock(millis: number, utcOffsetSeconds: number): PumpClock {
  const d = new Date(millis + utcOffsetSeconds * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

export type PumpAlarmType =
  | 'batteryOutLimitExceeded'
  | 'noDelivery'
  | 'batteryDepleted'
  | 'autoOff'
  | 'deviceReset'
  | 'deviceResetBatteryIssue17'
  | 'deviceResetBatteryIssue21'
  | 'reprogramError'
  | 'emptyReservoir'
  | 'unknown';

export function alarmTypeOf(raw: number): PumpAlarmType {
  switch (raw) {
    case 3:
      return 'batteryOutLimitExceeded';
    case 4:
      return 'noDelivery';
    case 5:
      return 'batteryDepleted';
    case 6:
      return 'autoOff';
    case 16:
      return 'deviceReset';
    case 17:
      return 'deviceResetBatteryIssue17';
    case 21:
      return 'deviceResetBatteryIssue21';
    case 61:
      return 'reprogramError';
    case 62:
      return 'emptyReservoir';
    default:
      return 'unknown';
  }
}

export interface UnabsorbedInsulinRecord {
  readonly amount: number;
  readonly age: number;
}

export type PumpEventDetail =
  | {
      readonly kind: 'bolus';
      /** units actually delivered */
      readonly amount: number;
      readonly programmed: number;
      readonly unabsorbedInsulinTotal: number;
      readonly bolusType: 'normal' | 'square';
      /** square wave duration in ms, 0 for a normal bolus */
      readonly durationMs: number;
      readonly wasRemotelyTriggered: boolean;
      readonly unabsorbedInsulinRecords?: readonly UnabsorbedInsulinRecord[];
    }
  | { readonly kind: 'tempBasal'; readonly rateType: 'absolute' | 'percent'; readonly rate: number; readonly wasRemotelyTriggered: boolean }
  | { readonly kind: 'tempBasalDuration'; readonly durationMin: number }
  | { readonly kind: 'suspend'; readonly wasRemotelyTriggered: boolean }
  | { readonly kind: 'resume'; readonly wasRemotelyTriggered: boolean }
  | { readonly kind: 'prime'; readonly amount: number; readonly programmedAmount: number; readonly primeType: 'manual' | 'fixed' }
  | { readonly kind: 'rewind' }
  | { readonly kind: 'alarm'; readonly alarmType: PumpAlarmType }
  | { readonly kind: 'clearAlarm'; readonly alarmType: PumpAlarmType }
  | { readonly kind: 'basalProfileStart'; readonly index: number; readonly offsetMin: number; readonly rate: number }
  | { readonly kind: 'unabsorbedInsulin'; readonly records: readonly UnabsorbedInsulinRecord[] }
  | { readonly kind: 'newTime' }
  | { readonly kind: 'changeTime' }
  | { readonly kind: 'other' };

export type PumpEvent = PumpEventDetail & {
  /** `PumpEventType` name, for logs */
  readonly name: string;
  /** record length in bytes (how far the page walk advances) */
  readonly length: number;
  readonly rawData: Bytes;
  /** null for records without a timestamp */
  readonly timestamp: PumpClock | null;
};

type Decoded = PumpEventDetail;

function decodeDetail(type: number, d: Bytes, model: PumpModel): Decoded {
  const flag = (i: number): boolean => (d[i]! & 0b01000000) !== 0;
  switch (type) {
    case EventType.bolusNormal: {
      const larger = isLargerModel(model);
      const scale = insulinBitPackingScale(model);
      const insulin = (from: number, to: number): number => (to - from === 2 ? u16be(d, from) : d[from]!) / scale;
      const programmed = larger ? insulin(1, 3) : insulin(1, 2);
      const amount = larger ? insulin(3, 5) : insulin(2, 3);
      const unabsorbedInsulinTotal = larger ? insulin(5, 7) : 0;
      const durationMs = (larger ? d[7]! : d[3]!) * 30 * 60_000;
      return { kind: 'bolus', amount, programmed, unabsorbedInsulinTotal, durationMs, bolusType: durationMs > 0 ? 'square' : 'normal', wasRemotelyTriggered: larger ? flag(11) : flag(7) };
    }
    case EventType.tempBasal: {
      const percent = d[7]! >> 3 !== 0;
      return {
        kind: 'tempBasal',
        rateType: percent ? 'percent' : 'absolute',
        rate: percent ? d[1]! : (((d[7]! & 0b111) << 8) + d[1]!) / 40,
        wasRemotelyTriggered: flag(5),
      };
    }
    case EventType.tempBasalDuration:
      return { kind: 'tempBasalDuration', durationMin: d[1]! * 30 };
    case EventType.suspend:
      return { kind: 'suspend', wasRemotelyTriggered: flag(5) };
    case EventType.resume:
      return { kind: 'resume', wasRemotelyTriggered: flag(5) };
    case EventType.prime: {
      const programmedAmount = (d[2]! << 2) / 40;
      return { kind: 'prime', amount: (d[4]! << 2) / 40, programmedAmount, primeType: programmedAmount === 0 ? 'manual' : 'fixed' };
    }
    case EventType.rewind:
      return { kind: 'rewind' };
    case EventType.alarmPump:
      return { kind: 'alarm', alarmType: alarmTypeOf(d[1]!) };
    case EventType.clearAlarm:
      return { kind: 'clearAlarm', alarmType: alarmTypeOf(d[1]!) };
    case EventType.basalProfileStart:
      return { kind: 'basalProfileStart', index: d[1]!, offsetMin: d[7]! * 30, rate: (d[8]! | (d[9]! << 8)) / 40 };
    case EventType.newTime:
      return { kind: 'newTime' };
    case EventType.changeTime:
      return { kind: 'changeTime' };
    default:
      return { kind: 'other' };
  }
}

/** One record at the start of `available`; null when the type is unknown or the data is too short. */
export function decodeEvent(available: Bytes, model: PumpModel): PumpEvent | null {
  const type = available[0];
  if (type === undefined) return null;
  const layout = eventLayout(type, model);
  if (!layout) return null;

  if (type === EventType.unabsorbedInsulin) {
    const length = Math.max(available[1] ?? 0, 2);
    if (length > available.length) return null;
    const records: UnabsorbedInsulinRecord[] = [];
    for (let i = 0; i < Math.floor((available[1]! - 2) / 3); i++) {
      records.push({ amount: available[2 + i * 3]! / 40, age: available[3 + i * 3]! + ((available[4 + i * 3]! & 0b110000) << 4) });
    }
    return { kind: 'unabsorbedInsulin', records, name: layout.name, length, rawData: available.slice(0, length), timestamp: null };
  }

  // DailyTotal523 only needs 16 bytes to be recognised (the Swift guard), the others their full length
  const needed = type === 0x6e ? 16 : layout.length;
  if (needed > available.length) return null;
  const rawData = available.slice(0, Math.min(layout.length, available.length));
  const timestamp = layout.timestampOffset === null ? null : pumpEventTimestamp(available, layout.timestampOffset);
  return { ...decodeDetail(type, available, model), name: layout.name, length: layout.length, rawData, timestamp };
}

// ── history page ─────────────────────────────────────────────────────────────

export class HistoryPageError extends Error {
  constructor(
    readonly kind: 'invalidCRC' | 'unknownEventType',
    message: string,
  ) {
    super(message);
    this.name = 'HistoryPageError';
  }
}

export const HISTORY_PAGE_LENGTH = 1024;

/**
 * Decodes the events of a 1024 byte history page, oldest first. Zero bytes between records are
 * skipped; an unknown record type makes the page undecodable (the walk would lose its place).
 * Unabsorbed insulin records are attached to the bolus that follows them and not listed themselves.
 */
export function parseHistoryPage(pageData: Bytes, model: PumpModel): PumpEvent[] {
  if (!checkCrc16(pageData)) throw new HistoryPageError('invalidCRC', 'History page failed crc check');
  const data = pageData.subarray(0, 1022);
  const events: PumpEvent[] = [];
  let unabsorbed: Extract<PumpEvent, { kind: 'unabsorbedInsulin' }> | null = null;
  let offset = 0;
  while (offset < data.length) {
    if (data[offset] === 0) {
      offset += 1;
      continue;
    }
    let event = decodeEvent(data.subarray(offset), model);
    if (!event) throw new HistoryPageError('unknownEventType', `Unknown history record type: ${data[offset]}`);
    if (unabsorbed && event.kind === 'bolus') {
      event = { ...event, unabsorbedInsulinRecords: unabsorbed.records };
      unabsorbed = null;
    }
    if (event.kind === 'unabsorbedInsulin') unabsorbed = event;
    else events.push(event);
    offset += event.length;
  }
  return events;
}

// ── timestamped events ───────────────────────────────────────────────────────

export interface TimestampedHistoryEvent {
  readonly event: PumpEvent;
  /** corrected for time changes on the pump, ms since the epoch */
  readonly date: number;
}

/** A bolus record is appended after delivery, except square waves on pumps that append them at the start. */
const isDelayedAppend = (e: PumpEvent, model: PumpModel): boolean => e.kind === 'bolus' && (e.bolusType !== 'square' || !appendsSquareWaveOnStart(model));

const MINUTE = 60_000;

/**
 * The events newer than `start`, oldest first (`HistoryPage.timestampedEvents`). Walks the page from
 * the newest record backwards, de-duplicates records with identical bytes, corrects for clock
 * changes and stops at the first record at or before `start`, at a clock that jumped back by an
 * hour or more, or at a device reset alarm (the pump forgot its clock).
 */
export function timestampedEvents(
  events: readonly PumpEvent[],
  o: { readonly after: number; readonly utcOffsetSeconds: number; readonly model: PumpModel; readonly now: number },
): { events: TimestampedHistoryEvent[]; hasMoreEvents: boolean; cancelledEarly: boolean } {
  let timeCursor = o.now + 60 * MINUTE;
  const out: TimestampedHistoryEvent[] = [];
  let timeAdjustment = 0;
  const seen = new Set<string>();
  let last: PumpEvent | undefined;

  for (const event of [...events].reverse()) {
    if (event.timestamp !== null && !seen.has(hex(event.rawData))) {
      seen.add(hex(event.rawData));
      const at = pumpClockToMillis(event.timestamp, o.utcOffsetSeconds);

      if (event.kind === 'changeTime' && last?.kind === 'newTime' && last.timestamp) {
        timeAdjustment += pumpClockToMillis(last.timestamp, o.utcOffsetSeconds) - at;
      }
      if (event.kind === 'alarm' && (event.alarmType === 'deviceResetBatteryIssue17' || event.alarmType === 'deviceResetBatteryIssue21')) {
        return { events: out, hasMoreEvents: false, cancelledEarly: true };
      }
      const date = at + timeAdjustment;
      if (Number.isFinite(date)) {
        if (!isDelayedAppend(event, o.model)) {
          if (date <= o.after) return { events: out, hasMoreEvents: false, cancelledEarly: false };
          if (date - timeCursor > 60 * MINUTE) return { events: out, hasMoreEvents: false, cancelledEarly: true };
          timeCursor = date;
        }
        out.unshift({ event, date });
      }
    }
    last = event;
  }
  return { events: out, hasMoreEvents: true, cancelledEarly: false };
}

/** How long the pump takes for a bolus record: its square wave duration, else the delivery time of the amount. */
export const bolusRecordDurationMs = (e: Extract<PumpEvent, { kind: 'bolus' }>, model: PumpModel): number => (e.durationMs > 0 ? e.durationMs : bolusDeliveryTimeMs(model, e.amount));
