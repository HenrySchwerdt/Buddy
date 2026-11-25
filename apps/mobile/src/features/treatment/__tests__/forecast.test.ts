import { describe, expect, it } from 'vitest';
import { forecastCone, lowestPrediction } from '../forecast';

describe('forecast cone', () => {
  it('takes min and max per index over all lines', () => {
    const iob = Array.from({ length: 20 }, (_, i) => 150 - i);
    const cob = Array.from({ length: 15 }, (_, i) => 150 + i);
    const c = forecastCone({ iob, cob });
    expect(c.count).toBe(15);
    expect(c.min[0]).toBe(150);
    expect(c.min[14]).toBe(136);
    expect(c.max[14]).toBe(164);
  });
  it('draws at least 12 points, beyond short lines from the longer ones', () => {
    const c = forecastCone({ iob: [100, 101, 102], zt: Array.from({ length: 30 }, () => 90) });
    expect(c.count).toBe(12);
    expect(c.min[5]).toBe(90);
    expect(c.max[5]).toBe(90);
  });
  it('is empty without predictions', () => {
    expect(forecastCone(undefined).min).toEqual([]);
    expect(lowestPrediction({ iob: [120, 80, 95] })).toBe(80);
    expect(lowestPrediction(null)).toBeNull();
  });
});
