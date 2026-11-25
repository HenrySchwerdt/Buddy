import { describe, expect, it } from 'vitest';
import { parseTreatmentsToCarbs, parseTreatmentsToDoses } from '../src';

describe('Nightscout follower: external insulin', () => {
  it('marks Trio "External Insulin" treatments as external boluses', () => {
    // Arrange
    const body = [{ _id: 'a', eventType: 'External Insulin', insulin: 2, created_at: '2026-11-25T10:00:00Z' }];

    // Act
    const [dose] = parseTreatmentsToDoses(body);

    // Assert
    expect(dose).toMatchObject({ kind: 'bolus', units: 2, external: true });
  });

  it('keeps pump boluses non-external', () => {
    const [dose] = parseTreatmentsToDoses([{ _id: 'b', eventType: 'Bolus', insulin: 1, created_at: '2026-11-25T10:00:00Z' }]);
    expect(dose).toMatchObject({ kind: 'bolus', units: 1 });
    expect(dose && 'external' in dose ? dose.external : undefined).toBeUndefined();
  });
});

describe('Nightscout follower: Buddy uploads are not re-imported (shadow-mode double count)', () => {
  const at = '2026-11-25T10:00:00Z';

  it('skips doses Buddy uploaded itself but keeps Trio-entered ones', () => {
    const doses = parseTreatmentsToDoses([
      { _id: 'mine', eventType: 'External Insulin', insulin: 2, enteredBy: 'Buddy', created_at: at },
      { _id: 'mine2', eventType: 'Temp Basal', rate: 1, duration: 30, enteredBy: 'Buddy', created_at: at },
      { _id: 'trio', eventType: 'External Insulin', insulin: 3, enteredBy: 'Trio', created_at: at },
    ]);
    expect(doses.map((d) => d.id)).toEqual(['ns-bolus-trio']);
  });

  it('skips carbs Buddy uploaded itself but keeps Trio-entered ones', () => {
    const carbs = parseTreatmentsToCarbs([
      { _id: 'mine', eventType: 'Carb Correction', carbs: 20, enteredBy: 'Buddy', created_at: at },
      { _id: 'trio', eventType: 'Carb Correction', carbs: 30, enteredBy: 'Trio', created_at: at },
    ]);
    expect(carbs.map((c) => [c.id, c.grams])).toEqual([['ns-carbs-trio', 30]]);
  });
});
