import { describe, expect, it } from 'vitest';
import type { ActiveOverride, ActiveTempTarget, GlucoseReading, InsulinDose, LoopRun } from '@buddy/core';
import {
  INDEFINITE_OVERRIDE_MIN,
  mapCarbsToTreatments,
  mapDosesToTreatments,
  mapGlucoseToEntries,
  mapLoopRunToDeviceStatus,
  mapOverrideToTreatment,
  mapTempTargetToTreatment,
} from '../src';
import { MIN, PUMP, RUN, T0, iso } from './fixtures';


describe('mapGlucoseToEntries', () => {
  it('maps a CGM reading to a Trio-shaped sgv entry', () => {
    const readings: GlucoseReading[] = [{ date: T0, value: 123.4, trend: 'fortyFiveUp', source: 'dexcom-g7', noise: 1 }];
    expect(mapGlucoseToEntries(readings)).toEqual([
      { type: 'sgv', sgv: 123, direction: 'FortyFiveUp', date: T0, dateString: '2026-11-25T12:00:00.000Z', noise: 1, device: 'Buddy', identifier: `dexcom-g7-${T0}` },
    ]);
  });

  it('maps unknown trend to NONE and omits a missing trend', () => {
    const [a, b] = mapGlucoseToEntries([
      { date: T0, value: 100, trend: 'unknown', source: 'libre' },
      { date: T0 + 5 * MIN, value: 101, source: 'libre' },
    ]);
    expect(a?.direction).toBe('NONE');
    expect(b).not.toHaveProperty('direction');
  });

  it('skips readings that came from a Nightscout CGM source', () => {
    const out = mapGlucoseToEntries([
      { date: T0, value: 110, source: 'nightscout' },
      { date: T0 + MIN, value: 111, source: 'dexcom-g6' },
    ]);
    expect(out.map((e) => e.sgv)).toEqual([111]);
  });
});

describe('mapDosesToTreatments (PumpHistoryStorage field names)', () => {
  const doses: InsulinDose[] = [
    { kind: 'smb', id: 'd1', date: T0, units: 0.30000000000000004 },
    { kind: 'bolus', id: 'd2', date: T0 + MIN, units: 4.2 },
    { kind: 'tempBasal', id: 'd3', date: T0 + 2 * MIN, rate: 1.65, durationMin: 30 },
    { kind: 'tempBasal', id: 'd4', date: T0 + 3 * MIN, rate: 0.8, durationMin: 0 },
  ];

  it('maps SMB, Bolus and Temp Basal', () => {
    expect(mapDosesToTreatments(doses)).toEqual([
      { eventType: 'SMB', created_at: iso(T0), enteredBy: 'Buddy', identifier: 'd1', id: 'd1', insulin: 0.3 },
      { eventType: 'Bolus', created_at: iso(T0 + MIN), enteredBy: 'Buddy', identifier: 'd2', id: 'd2', insulin: 4.2 },
      { eventType: 'Temp Basal', created_at: iso(T0 + 2 * MIN), enteredBy: 'Buddy', identifier: 'd3', id: 'd3', duration: 30, absolute: 1.65, rate: 1.65 },
      // Zero-duration temp ends the running temp, as in Trio.
      { eventType: 'Temp Basal', created_at: iso(T0 + 3 * MIN), enteredBy: 'Buddy', identifier: 'd4', id: 'd4', duration: 0, absolute: 0.8, rate: 0.8 },
    ]);
  });

  it('maps a suspend to PumpSuspend / PumpResume notes like Trio', () => {
    const out = mapDosesToTreatments([{ kind: 'suspend', id: 's1', date: T0, durationMin: 20 }]);
    expect(out).toEqual([
      { eventType: 'Note', created_at: iso(T0), enteredBy: 'Buddy', identifier: 's1', id: 's1', notes: 'PumpSuspend' },
      { eventType: 'Note', created_at: iso(T0 + 20 * MIN), enteredBy: 'Buddy', identifier: 's1-resume', id: 's1-resume', notes: 'PumpResume' },
    ]);
  });

  it('emits only the suspend note while the suspend is open-ended', () => {
    expect(mapDosesToTreatments([{ kind: 'suspend', id: 's2', date: T0, durationMin: 0 }]).map((t) => t.notes)).toEqual(['PumpSuspend']);
  });

  it('skips doses read back from Nightscout (shadow mode ids)', () => {
    expect(mapDosesToTreatments([{ kind: 'bolus', id: 'ns-bolus-abc', date: T0, units: 1 }])).toEqual([]);
  });
});

describe('mapCarbsToTreatments', () => {
  it('maps a carb entry to Carb Correction', () => {
    expect(mapCarbsToTreatments([{ id: 'c1', date: T0, grams: 45, absorptionHours: 3 }])).toEqual([
      { eventType: 'Carb Correction', created_at: iso(T0), enteredBy: 'Buddy', identifier: 'c1', id: 'c1', carbs: 45, absorptionTime: 180 },
    ]);
  });

  it('includes fat, protein and note when present', () => {
    const [t] = mapCarbsToTreatments([{ id: 'c2', date: T0, grams: 30, fat: 12, protein: 20, note: 'Pizza' }]);
    expect(t).toMatchObject({ carbs: 30, fat: 12, protein: 20, notes: 'Pizza' });
  });

  it('skips carbs read back from Nightscout', () => {
    expect(mapCarbsToTreatments([{ id: 'ns-carbs-x', date: T0, grams: 10 }])).toEqual([]);
  });
});

describe('temp targets and overrides', () => {
  it('maps a temp target to Temporary Target with top = bottom', () => {
    const tt: ActiveTempTarget = { id: 'activity', name: 'Activity', target: 140, durationMin: 60, startedAt: T0 };
    expect(mapTempTargetToTreatment(tt)).toEqual({
      eventType: 'Temporary Target',
      created_at: iso(T0),
      enteredBy: 'Buddy',
      identifier: `tt-activity-${T0}`,
      id: `tt-activity-${T0}`,
      duration: 60,
      targetTop: 140,
      targetBottom: 140,
      units: 'mg/dl',
      notes: 'Activity',
    });
  });

  it('maps an override to Exercise; indefinite gets 30 days like Trio', () => {
    const o: ActiveOverride = { id: 'sick', name: 'Sick day', percentage: 130, target: null, scaleIsf: true, scaleCr: true, disableSmb: false, durationMin: null, startedAt: T0 };
    expect(mapOverrideToTreatment(o)).toEqual({
      eventType: 'Exercise',
      created_at: iso(T0),
      enteredBy: 'Buddy',
      identifier: `override-sick-${T0}`,
      id: `override-sick-${T0}`,
      duration: INDEFINITE_OVERRIDE_MIN,
      notes: 'Sick day',
    });
    expect(mapOverrideToTreatment({ ...o, durationMin: 90 }).duration).toBe(90);
  });
});

describe('mapLoopRunToDeviceStatus (NightscoutStatus field names)', () => {
  it('maps a closed-loop run to openaps suggested/enacted, pump and uploader', () => {
    const at = iso(T0);
    const common = {
      reason: 'COB: 20, Dev: 12; Safety: Basal clamped to 2.5 U/h',
      timestamp: at,
      deliverAt: at,
      bg: 152,
      IOB: 2.123,
      COB: 20,
      eventualBG: 142,
      insulinReq: 0.8,
      sensitivityRatio: 1.1,
      predBGs: { IOB: [152, 150], ZT: [152, 140], COB: [152, 160], UAM: [152, 155] },
      rate: 2.5,
      duration: 30,
      units: 0.4,
    };
    expect(mapLoopRunToDeviceStatus(RUN, PUMP, { version: '0.1.0', uploaderBattery: 81.2, isCharging: true })).toEqual({
      device: 'Buddy',
      created_at: at,
      openaps: {
        iob: { iob: 2.123, time: at },
        suggested: common,
        enacted: { ...common, received: true },
        version: '0.1.0',
        dosingMode: 'closed',
      },
      pump: {
        clock: iso(T0 - MIN),
        reservoir: 132.46,
        battery: { percent: 70 },
        status: { status: 'normal', bolusing: false, suspended: false, timestamp: iso(T0 - MIN) },
        bolusIncrement: 0.05,
      },
      uploader: { battery: 81, isCharging: true },
    });
  });

  it('maps a cancel to rate 0 / duration 0 and omits enacted in open loop', () => {
    const open: LoopRun = { ...RUN, mode: 'open', interventions: [], guarded: { tempBasal: null, reason: 'low' }, enacted: null };
    const s = mapLoopRunToDeviceStatus(open, { ...PUMP, suspended: true, reservoirUnits: null, batteryPercent: null }, {});
    expect(s.openaps.suggested).toMatchObject({ rate: 0, duration: 0, reason: 'low' });
    expect(s.openaps.suggested).not.toHaveProperty('units');
    expect(s.openaps).not.toHaveProperty('enacted');
    expect(s.openaps.version).toBe('Unknown');
    expect(s.pump?.status.status).toBe('suspended');
    expect(s.pump).not.toHaveProperty('reservoir');
    expect(s.pump).not.toHaveProperty('battery');
    expect(s).not.toHaveProperty('uploader');
  });

  it('omits enacted when nothing was commanded, and pump when unknown', () => {
    const s = mapLoopRunToDeviceStatus({ ...RUN, enacted: {} }, null);
    expect(s.openaps).not.toHaveProperty('enacted');
    expect(s).not.toHaveProperty('pump');
  });

  it('uses a single generic prediction as the IOB line', () => {
    const s = mapLoopRunToDeviceStatus({ ...RUN, guarded: { reason: 'x', predictions: { main: [100, 101] } } }, null);
    expect(s.openaps.suggested?.predBGs).toEqual({ IOB: [100, 101] });
  });

  it('omits suggested for a failed run without decision', () => {
    const s = mapLoopRunToDeviceStatus({ ...RUN, suggested: null, guarded: null, enacted: null, error: 'No glucose data', glucose: null }, null);
    expect(s.openaps).not.toHaveProperty('suggested');
    expect(s.openaps.iob.iob).toBe(2.123);
  });
});

describe('external insulin and carb notes (Trio parity)', () => {
  it('uploads external insulin as an External Insulin treatment, not a Bolus', () => {
    const doses: InsulinDose[] = [{ kind: 'bolus', id: 'e1', date: T0, units: 2.5, external: true }];
    expect(mapDosesToTreatments(doses)).toEqual([
      { eventType: 'External Insulin', created_at: iso(T0), enteredBy: 'Buddy', identifier: 'e1', id: 'e1', insulin: 2.5 },
    ]);
  });

  it('still uploads a pump bolus as Bolus', () => {
    const [t] = mapDosesToTreatments([{ kind: 'bolus', id: 'b1', date: T0, units: 1 }]);
    expect(t?.eventType).toBe('Bolus');
  });

  it('sends a carb note as both notes and foodType, like Trio', () => {
    const [t] = mapCarbsToTreatments([{ id: 'c3', date: T0, grams: 30, note: 'Pizza' }]);
    expect(t).toMatchObject({ notes: 'Pizza', foodType: 'Pizza' });
  });

  it('omits notes and foodType when the carb entry has no note', () => {
    const [t] = mapCarbsToTreatments([{ id: 'c4', date: T0, grams: 30 }]);
    expect(t).not.toHaveProperty('notes');
    expect(t).not.toHaveProperty('foodType');
  });
});
