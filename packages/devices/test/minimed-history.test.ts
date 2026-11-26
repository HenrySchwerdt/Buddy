/**
 * MiniMed history pages: the real pages of MinimedKitTests (MinimedKit, migrated from
 * ps2/rileylink_ios, MIT License, (c) LoopKit Authors) decoded record by record, the walk rules of
 * `timestampedEvents`, and the conversion of history records to doses.
 */
import { describe, expect, it } from 'vitest';
import { fromHex } from '@buddy/core';
import {
  alarmTypeOf,
  decodeEvent,
  encodePumpEventTimestamp,
  HistoryPageError,
  millisToPumpClock,
  parseHistoryPage,
  pumpClockToMillis,
  pumpEventTimestamp,
  timestampedEvents,
  type PumpEvent,
} from '../src/minimed/history/events';
import { bolusesFromHistory, dosesFromHistory, tempBasalsFromHistory } from '../src/minimed/history/doses';
import type { PumpModel } from '../src/minimed/models';
import { HISTORY_PAGES } from './minimed-fixtures';

const page = (name: string): PumpEvent[] => {
  const p = HISTORY_PAGES[name]!;
  return parseHistoryPage(fromHex(p.hex), p.model as PumpModel);
};
const at = (e: PumpEvent) => e.timestamp!;
const when = (year: number, month: number, day: number, hour: number, minute: number, second: number) => ({ year, month, day, hour, minute, second });

describe('MiniMed history timestamps', () => {
  it('decodes the 5 byte timestamp of a record', () => {
    const c = pumpEventTimestamp(fromHex('010018001800440001b8571510'), 8);
    expect(c).toEqual(when(2016, 2, 21, 23, 56, 1));
  });

  it('encodes a timestamp the same way (round trip, all months)', () => {
    for (let month = 1; month <= 12; month++) {
      const c = when(2026, month, 28, 23, 59, 58);
      expect(pumpEventTimestamp(encodePumpEventTimestamp(c), 0)).toEqual(c);
    }
  });

  it('converts between the pump wall clock and absolute time', () => {
    const c = when(2026, 11, 25, 9, 0, 0);
    const utc = Date.UTC(2026, 10, 25, 8, 0, 0);
    expect(pumpClockToMillis(c, 3600)).toBe(utc);
    expect(millisToPumpClock(utc, 3600)).toEqual(c);
    expect(pumpClockToMillis(c, -21600)).toBe(Date.UTC(2026, 10, 25, 15, 0, 0));
  });
});

describe('MiniMed history pages (vectors of HistoryPageTests)', () => {
  it('rejects a page with a wrong CRC and decodes the same page with a right one', () => {
    expect(() => page('testHistoryPageInvalidCRC')).toThrow(HistoryPageError);
    expect(() => page('testHistoryPageInvalidCRC')).toThrow(/crc/i);
    expect(() => page('testHistoryPageCRC')).not.toThrow();
  });

  it('walks past zero padding and rejects an unknown record type', () => {
    const p = HISTORY_PAGES.testTempBasalDecoding!;
    const bytes = fromHex(p.hex);
    bytes[0] = 0x68 - 0x68 + 0x04; // 0x04 is no pump event type
    expect(() => decodeEvent(bytes, '551')).not.toThrow();
    expect(decodeEvent(bytes, '551')).toBeNull();
  });

  it('decodes bolus, unabsorbed insulin, basal profile start, rewind and prime of a 5xx page', () => {
    const e = page('testHistoryDecoding');
    expect(e.length).toBeGreaterThan(20);
    expect(e[0]).toMatchObject({ name: 'bolusWizardBolusEstimate', kind: 'other' });
    expect(at(e[0]!)).toEqual(when(2016, 2, 21, 10, 34, 9));
    expect(e[1]).toMatchObject({ kind: 'bolus', amount: 3.2, programmed: 3.2, bolusType: 'normal', durationMs: 0, unabsorbedInsulinTotal: 0.9, wasRemotelyTriggered: false });
    expect(at(e[1]!)).toEqual(when(2016, 2, 21, 10, 34, 9));
    expect((e[1] as { unabsorbedInsulinRecords: unknown }).unabsorbedInsulinRecords).toEqual([
      { amount: 1.6, age: 79 },
      { amount: 1.4, age: 459 },
      { amount: 0.2, age: 469 },
    ]);
    expect(e[2]).toMatchObject({ kind: 'basalProfileStart', index: 5, offsetMin: 720, rate: 0.25 });
    expect(at(e[2]!)).toEqual(when(2016, 2, 21, 12, 0, 0));
    expect(e[20]).toMatchObject({ kind: 'rewind' });
    expect(at(e[20]!)).toEqual(when(2016, 2, 21, 20, 4, 3));
    expect(e[21]).toMatchObject({ kind: 'prime', amount: 5.4, primeType: 'manual', programmedAmount: 0 });
    expect(at(e[21]!)).toEqual(when(2016, 2, 21, 20, 5, 7));
    expect(e[50]).toMatchObject({ name: 'dailyTotal523', kind: 'other', timestamp: null });
  });

  it('decodes temp basal rate and duration records', () => {
    const e = page('testTempBasalDecoding');
    expect(e).toHaveLength(7);
    expect(e[0]).toMatchObject({ kind: 'tempBasalDuration', durationMin: 30 });
    expect(at(e[0]!)).toEqual(when(2016, 4, 18, 12, 35, 57));
    expect(e[1]).toMatchObject({ kind: 'tempBasal', rateType: 'absolute', rate: 0.4, wasRemotelyTriggered: false });
    expect(at(e[1]!)).toEqual(when(2016, 4, 18, 12, 42, 10));
    expect(e[2]).toMatchObject({ kind: 'tempBasalDuration', durationMin: 30 });
    expect(e[3]).toMatchObject({ kind: 'tempBasal', rate: 0.2 });
    expect(at(e[3]!)).toEqual(when(2016, 4, 18, 13, 0, 20));
  });

  it('decodes the high bits of a temp basal rate (up to 35 U/h)', () => {
    const e = page('testHighBitsOfTempBasalRate');
    expect(e).toHaveLength(90);
    expect([e[88], e[84], e[80], e[76]].map((x) => (x as { rate: number }).rate)).toEqual([34, 20, 10, 5]);
  });

  it('decodes a bolus of an x23 pump with the 2 byte amounts', () => {
    const e = page('testHistoryDecoding523');
    expect(e[0]).toMatchObject({ kind: 'bolus', amount: 2.05, programmed: 2.05, bolusType: 'normal', durationMs: 0, unabsorbedInsulinTotal: 0 });
    expect(at(e[0]!)).toEqual(when(2016, 4, 5, 20, 34, 2));
  });

  it('decodes a single bolus record of a 523 and the remote flag of a resume record', () => {
    const b = decodeEvent(fromHex('01009000900058008a344b1010'), '523')!;
    expect(b).toMatchObject({ kind: 'bolus', length: 13, programmed: 3.6, amount: 3.6, unabsorbedInsulinTotal: 2.2, bolusType: 'normal', durationMs: 0 });
    expect(b.timestamp).toMatchObject({ year: 2016, month: 8 });
    expect(decodeEvent(fromHex('1f20a4e30e0a13'), '523')).toMatchObject({ kind: 'resume', wasRemotelyTriggered: false });
    expect(decodeEvent(fromHex('1f209de40e4a13'), '523')).toMatchObject({ kind: 'resume', wasRemotelyTriggered: true });
    // a square wave bolus: the duration byte counts 30 minute steps
    expect(decodeEvent(fromHex('010080008000240209a24a1510'), '523')).toMatchObject({ kind: 'bolus', bolusType: 'square', durationMs: 2 * 30 * 60_000 });
  });

  it('knows every record length: the pages of all models decode with the Swift record counts', () => {
    const counts: Record<string, number> = {
      testHistoryQuestionable3b: 45,
      testMealMarkerFor754: 93,
      testInsulinMarker551: 72,
      testCalBGForPHWithHighBG: 67,
      testAlarmSensorDate: 82,
      testPumpAlarms: 126,
      testSaveSettings: 125,
      testBolusReminder: 32,
      testChangeSensorAlarmSilenceConfig: 118,
      testMeterBGx15: 106,
      testHistoryParsingShouldNotContinuePastAlarmsIndicatingUnrecoverableClock: 31,
    };
    for (const [name, n] of Object.entries(counts)) expect(page(name), name).toHaveLength(n);
    expect(() => page('testDroppedBolus')).not.toThrow();
    expect(() => page('testPageWithDuplicates')).not.toThrow();
  });

  it('names the records it does not decode', () => {
    expect(page('testSaveSettings')[79]).toMatchObject({ kind: 'other', name: 'saveSettings' });
    expect(page('testChangeSensorAlarmSilenceConfig')[21]).toMatchObject({ name: 'changeSensorAlarmSilenceConfig' });
    expect(page('testHistoryDecodingBolusWizardSettings522')[0]).toMatchObject({ name: 'bolusWizardSetup' });
    expect(at(page('testHistoryDecodingBolusWizardSettings522')[0]!)).toEqual(when(2016, 5, 29, 20, 16, 48));
    expect(page('testHistoryDecodingBolusWizardSettings522')[1]).toMatchObject({ kind: 'tempBasal' });
    const reminders = page('testBolusReminder');
    expect([16, 17, 18].map((i) => reminders[i]!.name)).toEqual(['bolusReminder', 'bolusReminder', 'bolusReminder']);
    expect([16, 17, 18].map((i) => at(reminders[i]!).hour)).toEqual([11, 14, 20]);
  });

  it('decodes alarms and keeps duplicate records apart', () => {
    const a = page('testPumpAlarms');
    expect(a[9]).toMatchObject({ kind: 'alarm', alarmType: 'deviceResetBatteryIssue21' });
    expect(at(a[9]!)).toEqual(when(2007, 1, 1, 0, 0, 0));
    expect(a[13]).toMatchObject({ kind: 'alarm', alarmType: 'batteryDepleted' });
    expect(alarmTypeOf(4)).toBe('noDelivery');
    expect(alarmTypeOf(99)).toBe('unknown');
    const d = page('testPageWithDuplicates');
    expect(d[116]!.rawData).toEqual(d[118]!.rawData);
  });
});

describe('MiniMed timestampedEvents (walk rules of HistoryPage+PumpOpsSession)', () => {
  const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
  const battery = (c: ReturnType<typeof when>): PumpEvent => decodeEvent(Uint8Array.from([0x1a, 0, ...encodePumpEventTimestamp(c)]), '523')!;
  const o = { utcOffsetSeconds: 0, model: '523' as PumpModel, now: NOW };
  const t = (hour: number, minute = 0) => when(2026, 11, 25, hour, minute, 0);

  it('returns events newer than the start, oldest first, and says whether more pages are needed', () => {
    const events = [battery(t(8)), battery(t(9)), battery(t(10))];
    const all = timestampedEvents(events, { ...o, after: 0 });
    expect(all.events.map((e) => new Date(e.date).getUTCHours())).toEqual([8, 9, 10]);
    expect(all.hasMoreEvents).toBe(true);
    const cut = timestampedEvents(events, { ...o, after: Date.UTC(2026, 10, 25, 8, 30) });
    expect(cut.events.map((e) => new Date(e.date).getUTCHours())).toEqual([9, 10]);
    expect(cut.hasMoreEvents).toBe(false);
    expect(cut.cancelledEarly).toBe(false);
  });

  it('stops when the pump clock jumped back (a device reset)', () => {
    // oldest first: the page says 2026, then 2007 (newest record): walking back from it, 2026 is an hour+ in the "future"
    const r = timestampedEvents([battery(t(10)), battery(when(2007, 1, 1, 0, 0, 0))], { ...o, after: 0 });
    expect(r.cancelledEarly).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(timestampedEvents([battery(t(9, 59)), battery(t(9, 0))], { ...o, after: 0 }).cancelledEarly).toBe(false); // under an hour out of order
  });

  it('stops at a device reset alarm', () => {
    const alarm = decodeEvent(Uint8Array.from([0x06, 21, 0, 0, ...encodePumpEventTimestamp(t(9))]), '523')!;
    const r = timestampedEvents([alarm, battery(t(10))], { ...o, after: 0 });
    expect(r).toMatchObject({ cancelledEarly: true, hasMoreEvents: false });
    expect(r.events).toHaveLength(1);
  });

  it('keeps one of several records with identical bytes', () => {
    expect(timestampedEvents([battery(t(9)), battery(t(9))], { ...o, after: 0 }).events).toHaveLength(1);
  });

  it('corrects for a change of the pump clock', () => {
    const stamp = (c: ReturnType<typeof when>) => encodePumpEventTimestamp(c);
    const changeTime = decodeEvent(Uint8Array.from([0x17, 0, ...stamp(t(9, 0))]), '523')!;
    const newTime = decodeEvent(Uint8Array.from([0x18, 0, ...stamp(t(10, 0))]), '523')!; // the clock was put forward one hour
    const before = battery(t(8)); // recorded before the change, in the old time
    const r = timestampedEvents([before, changeTime, newTime], { ...o, after: 0 });
    expect(r.events.find((e) => e.event === before)!.date).toBe(Date.UTC(2026, 10, 25, 9, 0, 0));
  });

  it('does not check the date of a bolus record (it is appended after delivery)', () => {
    const bolus = decodeEvent(fromHex('010080008000240209a24a1510'), '522')!; // 2016
    const r = timestampedEvents([bolus], { ...o, model: '522', after: Date.UTC(2020, 0, 1) });
    expect(r.events).toHaveLength(1);
    expect(r.hasMoreEvents).toBe(true);
  });

  it('applies to a real page (11 of 31 records after 2020-11-20 at -06:00)', () => {
    const events = page('testHistoryParsingShouldNotContinuePastAlarmsIndicatingUnrecoverableClock');
    const r = timestampedEvents(events, { after: Date.UTC(2020, 10, 20), utcOffsetSeconds: -21600, model: '522', now: Date.now() });
    expect(r.events).toHaveLength(11);
  });
});

describe('MiniMed history as doses', () => {
  it('turns bolus records into doses with the amount the pump delivered', () => {
    const events = page('testHistoryDecoding523');
    const stamped = timestampedEvents(events, { after: 0, utcOffsetSeconds: 0, model: '523', now: Date.now() }).events;
    const boluses = bolusesFromHistory(stamped);
    expect(boluses.length).toBeGreaterThan(0);
    expect(boluses[0]).toMatchObject({ amount: expect.any(Number), programmed: expect.any(Number) });
    const doses = dosesFromHistory(stamped);
    expect(doses.filter((d) => d.kind === 'bolus').reduce((s, d) => s + (d.kind === 'bolus' ? d.units : 0), 0)).toBeGreaterThan(0);
    expect(new Set(doses.map((d) => d.id)).size).toBe(doses.length); // ids are unique and derived from the record
  });

  it('pairs a temp basal rate with the duration record of the same time', () => {
    const stamped = timestampedEvents(page('testTempBasalDecoding'), { after: 0, utcOffsetSeconds: 0, model: '551', now: Date.now() }).events;
    const temps = tempBasalsFromHistory(stamped);
    expect(temps.map((x) => [x.rate, x.durationMin])).toEqual([
      [0.4, 30],
      [0.2, 30],
    ]);
  });

  it('counts the time between a rewind and the next prime as suspended', () => {
    const stamped = timestampedEvents(page('testHistoryDecoding'), { after: 0, utcOffsetSeconds: 0, model: '551', now: Date.now() }).events;
    const suspends = dosesFromHistory(stamped).filter((d) => d.kind === 'suspend');
    expect(suspends.length).toBeGreaterThan(0);
    expect(suspends.some((d) => d.kind === 'suspend' && Math.abs(d.durationMin - 1.067) < 0.1)).toBe(true); // rewind 20:04:03, prime 20:05:07
  });
});
