import { describe, expect, it } from 'vitest';
import { silentLogger } from '@buddy/core';
import { MAX_BATCH, createNightscoutUploader, hashApiSecret } from '../src';
import { MIN, PUMP, RUN, T0 } from './fixtures';
/** Fake fetch that records every request; `fail(path)` decides per request whether to return an error. */
function fakeFetch(fail = () => null) {
    const requests = [];
    const fn = (async (input, init) => {
        const url = String(input);
        const path = new URL(url).pathname;
        const outcome = fail(path, requests.length);
        requests.push({ url, path, headers: (init?.headers ?? {}), body: JSON.parse(String(init?.body)) });
        if (outcome instanceof Error)
            throw outcome;
        const status = outcome ?? 200;
        return new Response('[]', { status });
    });
    return { fn, requests };
}
const clockAt = (t) => ({ now: () => t });
const glucose = (n, from = T0 - 3 * 60 * MIN) => Array.from({ length: n }, (_, i) => ({ date: from + i * MIN, value: 100 + (i % 50), source: 'dexcom-g7' }));
const empty = { glucose: [], doses: [], carbs: [], loopRuns: [], pump: null };
const uploader = (f, extra = {}) => createNightscoutUploader({
    url: extra.url ?? 'https://ns.example.com/',
    token: extra.token,
    apiSecret: extra.apiSecret,
    fetch: f.fn,
    clock: clockAt(extra.now ?? T0 + MIN),
    log: silentLogger,
});
describe('createNightscoutUploader', () => {
    it('posts each collection to its v1 endpoint', async () => {
        const f = fakeFetch();
        const doses = [{ kind: 'smb', id: 'd1', date: T0 - 10 * MIN, units: 0.2 }];
        const res = await uploader(f).upload({
            glucose: glucose(2),
            doses,
            carbs: [{ id: 'c1', date: T0 - 5 * MIN, grams: 20 }],
            loopRuns: [RUN],
            pump: PUMP,
            tempTargets: [{ id: 'activity', name: 'Activity', target: 140, durationMin: 60, startedAt: T0 - 20 * MIN }],
            overrides: [{ id: 'exercise', name: 'Exercise', percentage: 50, target: 150, scaleIsf: true, scaleCr: true, disableSmb: true, durationMin: 90, startedAt: T0 - 30 * MIN }],
        });
        expect(res.skipped).toBe(false);
        expect(Object.values(res.collections).every((c) => c.ok && c.uploaded === (c === res.collections.entries ? 2 : 1))).toBe(true);
        expect(f.requests.map((r) => r.path)).toEqual([
            '/api/v1/entries.json',
            '/api/v1/treatments.json',
            '/api/v1/treatments.json',
            '/api/v1/treatments.json',
            '/api/v1/treatments.json',
            '/api/v1/devicestatus.json',
        ]);
        expect(f.requests.map((r) => r.body[0]?.eventType ?? r.body[0]?.type ?? r.body[0]?.device)).toEqual([
            'sgv',
            'SMB',
            'Carb Correction',
            'Temporary Target',
            'Exercise',
            'Buddy',
        ]);
        expect(f.requests.every((r) => r.headers['Content-Type'] === 'application/json')).toBe(true);
    });
    it('uploads only items newer than the high-water marks', async () => {
        const f = fakeFetch();
        const up = uploader(f, { now: T0 + 60 * MIN });
        const first = glucose(3);
        await up.upload({ ...empty, glucose: first });
        expect(up.getState().entries).toBe(first[2].date);
        const more = [...first, ...glucose(2, first[2].date + 5 * MIN)];
        const res = await up.upload({ ...empty, glucose: more });
        expect(res.collections.entries).toEqual({ ok: true, uploaded: 2 });
        expect(f.requests).toHaveLength(2);
        expect(f.requests[1].body.map((e) => e.date)).toEqual([more[3].date, more[4].date]);
        const again = await up.upload({ ...empty, glucose: more });
        expect(again.collections.entries).toEqual({ ok: true, uploaded: 0 });
        expect(f.requests).toHaveLength(2);
    });
    it('restores persisted state via setState and initialState', async () => {
        const f = fakeFetch();
        const readings = glucose(4);
        const up = uploader(f);
        up.setState({ entries: readings[1].date });
        await up.upload({ ...empty, glucose: readings });
        expect(f.requests[0].body).toHaveLength(2);
        const f2 = fakeFetch();
        const restored = createNightscoutUploader({ url: 'https://ns.example.com', fetch: f2.fn, clock: clockAt(T0), log: silentLogger, initialState: up.getState() });
        await restored.upload({ ...empty, glucose: readings });
        expect(f2.requests).toHaveLength(0);
    });
    it('holds back items dated in the future until they are past (e.g. a scheduled resume note)', async () => {
        const f = fakeFetch();
        const suspend = { kind: 'suspend', id: 's1', date: T0, durationMin: 30 };
        const early = uploader(f, { now: T0 + 10 * MIN });
        const r1 = await early.upload({ ...empty, doses: [suspend] });
        expect(r1.collections.doses.uploaded).toBe(1);
        expect(f.requests[0].body[0].notes).toBe('PumpSuspend');
        const later = createNightscoutUploader({ url: 'https://ns.example.com', fetch: f.fn, clock: clockAt(T0 + 40 * MIN), log: silentLogger, initialState: early.getState() });
        const r2 = await later.upload({ ...empty, doses: [suspend] });
        expect(r2.collections.doses.uploaded).toBe(1);
        expect(f.requests[1].body[0].notes).toBe('PumpResume');
    });
    it('batches at most 100 documents per POST', async () => {
        const f = fakeFetch();
        const res = await uploader(f).upload({ ...empty, glucose: glucose(250, T0 - 300 * MIN) });
        expect(res.collections.entries).toEqual({ ok: true, uploaded: 250 });
        expect(f.requests.map((r) => r.body.length)).toEqual([MAX_BATCH, MAX_BATCH, 50]);
        // Oldest first, so the mark can advance per batch.
        expect(f.requests[0].body[0].date).toBeLessThan(f.requests[2].body[0].date);
    });
    it('sends a token as query parameter', async () => {
        const f = fakeFetch();
        await uploader(f, { token: 'buddy-abc123' }).upload({ ...empty, glucose: glucose(1) });
        expect(new URL(f.requests[0].url).searchParams.get('token')).toBe('buddy-abc123');
        expect(f.requests[0].headers).not.toHaveProperty('api-secret');
        expect(f.requests[0].url.startsWith('https://ns.example.com/api/v1/entries.json?')).toBe(true);
    });
    it('sends an API secret as sha1 hex header and never in the URL', async () => {
        const f = fakeFetch();
        await uploader(f, { apiSecret: 'my-secret-12chars' }).upload({ ...empty, glucose: glucose(1) });
        expect(hashApiSecret('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
        expect(f.requests[0].headers['api-secret']).toBe(hashApiSecret('my-secret-12chars'));
        expect(f.requests[0].url).toBe('https://ns.example.com/api/v1/entries.json');
    });
    it('reports HTTP failures per collection, keeps the mark, and continues with others', async () => {
        const f = fakeFetch((path) => (path.endsWith('entries.json') ? 401 : null));
        const up = uploader(f);
        const res = await up.upload({ ...empty, glucose: glucose(3), doses: [{ kind: 'bolus', id: 'b1', date: T0, units: 1 }] });
        expect(res.collections.entries).toEqual({ ok: false, uploaded: 0, error: 'Nightscout entries upload failed: HTTP 401' });
        expect(res.collections.doses).toEqual({ ok: true, uploaded: 1 });
        expect(up.getState().entries).toBe(0);
        expect(up.getState().doses).toBe(T0);
    });
    it('advances the mark per successful batch when a later batch fails', async () => {
        const f = fakeFetch((_path, n) => (n === 1 ? new Error('network down') : null));
        const up = uploader(f);
        const readings = glucose(150);
        const res = await up.upload({ ...empty, glucose: readings });
        expect(res.collections.entries).toEqual({ ok: false, uploaded: 100, error: 'Nightscout entries upload failed: network down' });
        expect(up.getState().entries).toBe(readings[99].date);
        const retry = await up.upload({ ...empty, glucose: readings });
        expect(retry.collections.entries).toEqual({ ok: true, uploaded: 50 });
    });
    it('does not skip items sharing a timestamp across a failed batch boundary', async () => {
        const f = fakeFetch((_path, n) => (n === 1 ? 500 : null));
        const up = uploader(f);
        const doses = Array.from({ length: 101 }, (_, i) => ({ kind: 'bolus', id: `b${i}`, date: i < 99 ? T0 - 100 * MIN + i * MIN : T0, units: 1 }));
        await up.upload({ ...empty, doses });
        expect(up.getState().doses).toBe(T0 - 1);
        const retry = await up.upload({ ...empty, doses });
        expect(retry.collections.doses.uploaded).toBe(2);
    });
    it('never throws, even on an invalid URL', async () => {
        const f = fakeFetch();
        const res = await uploader(f, { url: 'http://insecure.example.com' }).upload({ ...empty, glucose: glucose(1) });
        expect(res.collections.entries).toMatchObject({ ok: false, error: 'Nightscout URL must start with https://' });
        expect(f.requests).toHaveLength(0);
    });
    it('does nothing when the URL is empty', async () => {
        const f = fakeFetch();
        const res = await uploader(f, { url: '  ' }).upload({ ...empty, glucose: glucose(5), loopRuns: [RUN], pump: PUMP });
        expect(res.skipped).toBe(true);
        expect(f.requests).toHaveLength(0);
    });
    it('never re-uploads readings or treatments that came from Nightscout', async () => {
        const f = fakeFetch();
        const res = await uploader(f).upload({
            ...empty,
            glucose: [{ date: T0, value: 120, source: 'nightscout' }],
            doses: [{ kind: 'smb', id: 'ns-bolus-1', date: T0, units: 0.3 }],
            carbs: [{ id: 'ns-carbs-1', date: T0, grams: 10 }],
        });
        expect(res.collections.entries.uploaded).toBe(0);
        expect(res.collections.doses.uploaded).toBe(0);
        expect(res.collections.carbs.uploaded).toBe(0);
        expect(f.requests).toHaveLength(0);
    });
    it('uploads only the newest loop run as devicestatus', async () => {
        const f = fakeFetch();
        const older = { ...RUN, date: T0 - 5 * MIN };
        const res = await uploader(f).upload({ ...empty, loopRuns: [RUN, older], pump: PUMP });
        expect(res.collections.deviceStatus).toEqual({ ok: true, uploaded: 1 });
        expect(f.requests[0].body[0].created_at).toBe(new Date(T0).toISOString());
    });
    it('shares one in-flight upload between concurrent calls', async () => {
        const f = fakeFetch();
        const up = uploader(f);
        const snap = { ...empty, glucose: glucose(3) };
        const [a, b] = await Promise.all([up.upload(snap), up.upload(snap)]);
        expect(a).toBe(b);
        expect(f.requests).toHaveLength(1);
    });
});
