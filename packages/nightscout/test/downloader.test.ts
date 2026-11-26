import { describe, expect, it } from 'vitest';
import { silentLogger } from '@buddy/core';
import { createNightscoutDownloader, EXCLUDED_ENTERED_BY, mapNightscoutCarb, mapNightscoutTempTarget } from '../src';
import { iso, MIN, T0 } from './fixtures';

const CARBS = [
  { _id: 'c1', eventType: 'Carb Correction', created_at: iso(T0 - 30 * MIN), carbs: 45, notes: 'Pasta', enteredBy: 'Nightscout Care Portal' },
  { _id: 'c2', eventType: 'Meal Bolus', created_at: iso(T0 - 20 * MIN), carbs: 20, fat: 10, protein: 5, absorptionTime: 240 },
  { _id: 'c3', created_at: iso(T0 - 10 * MIN), carbs: 30, enteredBy: 'Buddy' },
  { _id: 'c4', created_at: iso(T0 - 9 * MIN), carbs: 30, enteredBy: 'Trio' },
  { _id: 'c5', created_at: iso(T0 - 8 * MIN), carbs: 30, identifier: 'ns-carb-x' },
  { _id: 'c6', created_at: iso(T0 - 7 * MIN), carbs: 0 },
  { _id: 'c7', created_at: iso(T0 - 6 * MIN), carbs: 12, actualDate: iso(T0 - 50 * MIN), enteredBy: 'xDrip' },
  { created_at: iso(T0 - 5 * MIN), carbs: 12 },
];

const TTS = [
  { _id: 't1', eventType: 'Temporary Target', created_at: iso(T0 - 60 * MIN), duration: 60, targetTop: 140, targetBottom: 140, reason: 'Activity', enteredBy: 'Nightscout' },
  { _id: 't2', eventType: 'Temporary Target', created_at: iso(T0 - 30 * MIN), duration: 0, reason: 'Cancel', enteredBy: 'Nightscout' },
  { _id: 't3', eventType: 'Temporary Target', created_at: iso(T0 - 20 * MIN), duration: 30, targetTop: 8, targetBottom: 8, units: 'mmol', notes: 'Eating soon' },
  { _id: 't4', eventType: 'Temporary Target', created_at: iso(T0 - 10 * MIN), duration: 60, targetTop: 120, targetBottom: 120, enteredBy: 'Buddy' },
  { _id: 't5', eventType: 'Temporary Target', created_at: iso(T0 - 5 * MIN), duration: 60, reason: 'no target' },
];

function server(body: unknown, status = 200) {
  const urls: URL[] = [];
  const headers: Record<string, string>[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(new URL(String(input)));
    headers.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, urls, headers };
}

const downloader = (s: ReturnType<typeof server>, extra: { url?: string; token?: string; apiSecret?: string; initialState?: { carbs?: number; tempTargets?: number } } = {}) =>
  createNightscoutDownloader({
    url: extra.url ?? 'https://ns.example.com',
    token: extra.token,
    apiSecret: extra.apiSecret,
    fetch: s.fn,
    clock: { now: () => T0 },
    log: silentLogger,
    initialState: extra.initialState,
  });

describe('fetchCarbs', () => {
  it('queries like Trio: carbs exist, not entered by us/other loops, newer than the high-water mark', async () => {
    const s = server([]);
    await downloader(s, { token: 'tok', apiSecret: 'secret' }).fetchCarbs();
    const u = s.urls[0]!;
    expect(u.pathname).toBe('/api/v1/treatments.json');
    expect(u.searchParams.get('find[carbs][$exists]')).toBe('true');
    expect(u.searchParams.get('find[created_at][$gt]')).toBe(iso(T0 - 24 * 60 * MIN));
    EXCLUDED_ENTERED_BY.forEach((v, i) => expect(u.searchParams.get(`find[$and][${i}][enteredBy][$ne]`)).toBe(v));
    expect(EXCLUDED_ENTERED_BY).toEqual(expect.arrayContaining(['Buddy', 'Trio', 'AndroidAPS', 'openaps://AndroidAPS', 'iAPS', 'loop://iPhone']));
    expect(u.searchParams.get('token')).toBe('tok');
    expect(s.headers[0]!['api-secret']).toMatch(/^[0-9a-f]{40}$/);
  });

  it('maps foreign carbs and skips Buddy/Trio uploads, ns- imports, empty and id-less docs', async () => {
    const r = await downloader(server(CARBS)).fetchCarbs();
    expect(r.ok).toBe(true);
    expect(r.carbs.map((c) => c.id)).toEqual(['ns-carb-c7', 'ns-carb-c1', 'ns-carb-c2']);
    const c2 = r.carbs.find((c) => c.id === 'ns-carb-c2')!;
    expect(c2).toMatchObject({ grams: 20, fat: 10, protein: 5, absorptionHours: 4, date: T0 - 20 * MIN });
    expect(r.carbs.find((c) => c.id === 'ns-carb-c1')).toMatchObject({ grams: 45, note: 'Pasta', enteredBy: 'Nightscout Care Portal' });
    // `actualDate` is the meal time (Trio dedupes on it)
    expect(r.carbs.find((c) => c.id === 'ns-carb-c7')!.date).toBe(T0 - 50 * MIN);
  });

  it('drops entries already stored locally by date or id and de-duplicates within a response', async () => {
    const dup = [CARBS[0]!, { ...CARBS[0]!, _id: 'c1b' }, CARBS[1]!];
    const r = await downloader(server(dup)).fetchCarbs({ carbDates: [T0 - 20 * MIN] });
    expect(r.carbs.map((c) => c.id)).toEqual(['ns-carb-c1']);
    const r2 = await downloader(server(dup)).fetchCarbs({ knownIds: ['c1', 'ns-carb-c2'] });
    expect(r2.carbs.map((c) => c.id)).toEqual(['ns-carb-c1b']);
  });

  it('advances the high-water mark only after success and narrows the next query', async () => {
    const fail = server({}, 500);
    const d = downloader(fail);
    const bad = await d.fetchCarbs();
    expect(bad).toMatchObject({ ok: false, carbs: [] });
    expect(d.getState().carbs).toBe(0);

    const s = server(CARBS);
    const d2 = downloader(s);
    await d2.fetchCarbs();
    expect(d2.getState().carbs).toBe(T0 - 5 * MIN);
    await d2.fetchCarbs();
    expect(s.urls[1]!.searchParams.get('find[created_at][$gt]')).toBe(iso(T0 - 5 * MIN));
  });

  it('never looks back more than a day, even with an old mark', async () => {
    const s = server([]);
    await downloader(s, { initialState: { carbs: T0 - 10 * 24 * 60 * MIN } }).fetchCarbs();
    expect(s.urls[0]!.searchParams.get('find[created_at][$gt]')).toBe(iso(T0 - 24 * 60 * MIN));
  });

  it('does nothing without a URL and rejects non-https URLs without throwing', async () => {
    const s = server(CARBS);
    expect(await downloader(s, { url: '' }).fetchCarbs()).toEqual({ ok: true, carbs: [] });
    expect(s.urls).toHaveLength(0);
    const bad = await downloader(s, { url: 'http://ns.example.com' }).fetchCarbs();
    expect(bad.ok).toBe(false);
  });

  it('reports malformed responses', async () => {
    expect((await downloader(server({ nope: 1 })).fetchCarbs()).ok).toBe(false);
  });
});

describe('fetchTempTargets', () => {
  it('queries Temporary Target treatments with a duration', async () => {
    const s = server([]);
    await downloader(s).fetchTempTargets();
    const u = s.urls[0]!;
    expect(u.searchParams.get('find[eventType]')).toBe('Temporary Target');
    expect(u.searchParams.get('find[duration][$exists]')).toBe('true');
    expect(u.searchParams.get('find[$and][0][enteredBy][$ne]')).toBe(EXCLUDED_ENTERED_BY[0]);
    expect(u.search).toContain('find%5BeventType%5D=Temporary+Target');
  });

  it('maps targets (mmol converted), reports cancels separately, skips own and target-less ones', async () => {
    const r = await downloader(server(TTS)).fetchTempTargets();
    expect(r.tempTargets.map((t) => t.id)).toEqual(['ns-tt-t1', 'ns-tt-t3']);
    expect(r.tempTargets[0]).toMatchObject({ name: 'Activity', target: 140, durationMin: 60, startedAt: T0 - 60 * MIN });
    expect(r.tempTargets[1]).toMatchObject({ name: 'Eating soon', target: 144, durationMin: 30 });
    expect(r.cancels).toEqual([T0 - 30 * MIN]);
  });

  it('drops temp targets already stored at the same start time', async () => {
    const r = await downloader(server(TTS)).fetchTempTargets({ tempTargetDates: [T0 - 60 * MIN] });
    expect(r.tempTargets.map((t) => t.id)).toEqual(['ns-tt-t3']);
  });

  it('keeps separate high-water marks per collection', async () => {
    const d = downloader(server(TTS));
    await d.fetchTempTargets();
    expect(d.getState()).toEqual({ carbs: 0, tempTargets: T0 - 5 * MIN });
  });
});

describe('mappers', () => {
  it('treats duration 0 as a cancel regardless of reason', () => {
    expect(mapNightscoutTempTarget({ _id: 'x', created_at: iso(T0), duration: 0, targetTop: 100, targetBottom: 100 })).toEqual({ cancel: T0 });
  });
  it('accepts numeric date strings and rejects bad dates', () => {
    expect(mapNightscoutCarb({ _id: 'x', created_at: 'garbage', carbs: 10 })).toBeNull();
    expect(mapNightscoutCarb({ _id: 'x', created_at: iso(T0), carbs: '15' })?.grams).toBe(15);
  });
});
