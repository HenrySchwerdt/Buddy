import { describe, expect, it } from 'vitest';
import type { DataSnapshot } from '@buddy/core';
import { DAY_MS, KEEP_HISTORY_MS, chunkSignature, dayOf, groupByDay, mergeHistory, planArchive, recentPart } from '../history-archive';

const NOW = Date.UTC(2026, 10, 25, 12);
const snap = (over: Partial<DataSnapshot> = {}): DataSnapshot => ({ glucose: [], doses: [], carbs: [], loopRuns: [], ...over });
const g = (daysAgo: number, h = 0) => ({ date: NOW - daysAgo * DAY_MS + h * 3_600_000, value: 100, source: 's' });

describe('groupByDay', () => {
  it('groups by UTC day and drops data beyond 90 days', () => {
    const days = groupByDay(snap({ glucose: [g(0), g(0, -1), g(3), g(91)] }), NOW);
    expect([...days.keys()].sort()).toEqual([dayOf(NOW) - 3, dayOf(NOW)]);
    expect(days.get(dayOf(NOW))!.glucose).toHaveLength(2);
    expect(KEEP_HISTORY_MS).toBe(90 * DAY_MS);
  });
});

describe('planArchive', () => {
  const data = snap({ glucose: [g(0), g(2)], carbs: [{ id: 'c1', date: NOW - 2 * DAY_MS, grams: 20 }] });
  it('writes everything the first time, nothing when unchanged', () => {
    const first = planArchive(data, NOW, new Map());
    expect(first.write.size).toBe(2);
    expect(planArchive(data, NOW, first.signatures).write.size).toBe(0);
  });
  it('rewrites only the changed day and removes days that became empty', () => {
    const first = planArchive(data, NOW, new Map());
    const grown = snap({ ...data, glucose: [...data.glucose, { ...g(0), date: NOW + 1000 }] });
    const next = planArchive(grown, NOW, first.signatures);
    expect([...next.write.keys()]).toEqual([dayOf(NOW)]);
    const deleted = planArchive(snap({ glucose: [g(0)] }), NOW, first.signatures);
    expect(deleted.remove).toEqual([dayOf(NOW) - 2]);
  });
  it('a deleted record changes the signature', () => {
    const a = chunkSignature({ glucose: [], doses: [], carbs: [{ id: 'a', date: 1, grams: 10 }, { id: 'b', date: 1, grams: 5 }] });
    const b = chunkSignature({ glucose: [], doses: [], carbs: [{ id: 'a', date: 1, grams: 10 }] });
    expect(a).not.toBe(b);
  });
});

describe('mergeHistory / recentPart', () => {
  it('merges archived days with the recent copy winning, sorted and deduplicated', () => {
    const recent = snap({ doses: [{ kind: 'bolus', id: 'b', date: NOW, units: 2 }] });
    const merged = mergeHistory(recent, [{ glucose: [g(2)], doses: [{ kind: 'bolus', id: 'b', date: NOW, units: 1 }, { kind: 'bolus', id: 'a', date: NOW - DAY_MS, units: 1 }], carbs: [] }]);
    expect(merged.doses.map((d) => d.id)).toEqual(['a', 'b']);
    expect(merged.doses[1]).toMatchObject({ units: 2 });
    expect(merged.glucose).toHaveLength(1);
  });
  it('recentPart keeps the last 26 hours', () => {
    const r = recentPart(snap({ glucose: [g(0), g(2)] }), NOW);
    expect(r.glucose).toHaveLength(1);
  });
});
