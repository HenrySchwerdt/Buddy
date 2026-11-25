import { describe, expect, it } from 'vitest';
import type { InsulinDose } from '@buddy/core';
import { mealRows, timeSpan, treatmentRows } from '../rows';
import { manualGlucoseMgdl, parseGlucoseInput } from '../validation';

const NOW = Date.UTC(2026, 10, 25, 12);
const MIN = 60_000;

describe('manual glucose validation', () => {
  it('accepts 14…720 mg/dL and rejects the rest', () => {
    expect(manualGlucoseMgdl(parseGlucoseInput('120'), 'mg/dL')).toBe(120);
    expect(manualGlucoseMgdl(parseGlucoseInput('13'), 'mg/dL')).toBeNull();
    expect(manualGlucoseMgdl(parseGlucoseInput('721'), 'mg/dL')).toBeNull();
    expect(manualGlucoseMgdl(parseGlucoseInput(''), 'mg/dL')).toBeNull();
  });

  it('converts mmol/L (comma or dot) to integer mg/dL', () => {
    expect(manualGlucoseMgdl(parseGlucoseInput('5,5'), 'mmol/L')).toBe(99);
    expect(manualGlucoseMgdl(parseGlucoseInput('0.5'), 'mmol/L')).toBeNull();
  });
});

describe('treatment rows', () => {
  it('maps doses of the last 24 h, newest first, none deletable (pump-delivered)', () => {
    const doses: InsulinDose[] = [
      { kind: 'bolus', id: 'b', date: NOW - 60 * MIN, units: 1.25 },
      { kind: 'smb', id: 's', date: NOW - 30 * MIN, units: 0.1 },
      { kind: 'tempBasal', id: 't', date: NOW - 10 * MIN, rate: 0.85, durationMin: 90 },
      { kind: 'bolus', id: 'old', date: NOW - 25 * 60 * MIN, units: 2 },
      { kind: 'bolus', id: 'future', date: NOW + MIN, units: 2 },
    ];
    const rows = treatmentRows(doses, NOW);
    expect(rows.map((r) => r.id)).toEqual(['t', 's', 'b']);
    expect(rows[0]).toMatchObject({ title: 'Temp Basal', duration: '1h 30m' });
    expect(rows[1]).toMatchObject({ title: 'SMB', type: 'smb' });
    expect(rows.every((r) => !r.deletable)).toBe(true);
  });
});

describe('meal rows', () => {
  it('hides future entries unless asked', () => {
    const carbs = [
      { id: 'a', date: NOW - MIN, grams: 30 },
      { id: 'f', date: NOW + 30 * MIN, grams: 10 },
    ];
    expect(mealRows(carbs, NOW, false).map((m) => m.id)).toEqual(['a']);
    expect(mealRows(carbs, NOW, true).map((m) => m.id)).toEqual(['f', 'a']);
  });
});

describe('timeSpan', () => {
  it('formats like Duration.formattedTimeSpan', () => {
    expect(timeSpan(30)).toBe('30m');
    expect(timeSpan(60)).toBe('1h');
  });
});

describe('external insulin rows', () => {
  it('shows external insulin as "External Insulin" with its own filter type', () => {
    const rows = treatmentRows([{ kind: 'bolus', id: 'e', date: NOW - 5 * MIN, units: 2.5, external: true }], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'External Insulin', type: 'externalBolus', amount: '2.5 U', dot: 'insulin' });
  });

  it('keeps pump boluses as Bolus', () => {
    const [row] = treatmentRows([{ kind: 'bolus', id: 'b', date: NOW - 5 * MIN, units: 1 }], NOW);
    expect(row).toMatchObject({ title: 'Bolus', type: 'bolus' });
  });
});

describe('meal rows with notes', () => {
  it('exposes the note of a carb entry', () => {
    const [row] = mealRows([{ id: 'a', date: NOW - MIN, grams: 30, note: 'Pizza' }], NOW, false);
    expect(row?.note).toBe('Pizza');
  });

  it('has no note for an entry without one or with a blank one', () => {
    const rows = mealRows([{ id: 'a', date: NOW - MIN, grams: 30 }, { id: 'b', date: NOW - 2 * MIN, grams: 10, note: '  ' }], NOW, false);
    expect(rows.map((r) => r.note)).toEqual([undefined, undefined]);
  });
});
