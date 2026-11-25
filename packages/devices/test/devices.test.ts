import { describe, expect, it } from 'vitest';
import { silentLogger, systemClock } from '@buddy/core';
import {
  createCgmRegistry,
  createPumpRegistry,
  demoCgm,
  demoHub,
  demoPump,
  nightscoutCgm,
  normalizeBaseUrl,
  parseNightscoutEntries,
  parseShareDate,
  parseShareReadings,
} from '../src';

const fakeFetch = (body: unknown, status = 200, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(url);
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;

describe('Nightscout CGM', () => {
  it('parses entries and drops implausible values', () => {
    const r = parseNightscoutEntries(
      [
        { sgv: 120, date: 1000, direction: 'Flat' },
        { sgv: 5, date: 2000 },
        { sgv: 'x', date: 3000 },
        { sgv: 150, date: 4000, direction: 'SingleUp' },
      ],
      'ns',
    );
    expect(r.map((x) => x.value)).toEqual([120, 150]);
    expect(r[1]!.trend).toBe('singleUp');
  });

  it('requires https', () => {
    expect(() => normalizeBaseUrl('http://x.com')).toThrow(/https/);
    expect(normalizeBaseUrl(' https://x.com/// ')).toBe('https://x.com');
  });

  it('queries entries since the last reading with the token', async () => {
    const seen: string[] = [];
    const cgm = nightscoutCgm.create({ url: 'https://ns.example', token: 'abc' }, { clock: systemClock, log: silentLogger, fetch: fakeFetch([{ sgv: 100, date: 5 }], 200, seen) });
    const r = await cgm.readings(1);
    expect(r).toHaveLength(1);
    expect(seen[0]).toContain('token=abc');
    expect(decodeURIComponent(seen[0]!)).toContain('find[date][$gt]=1');
  });

  it('surfaces HTTP errors', async () => {
    const cgm = nightscoutCgm.create({ url: 'https://ns.example', token: '' }, { clock: systemClock, log: silentLogger, fetch: fakeFetch({}, 401) });
    await expect(cgm.readings(0)).rejects.toThrow(/401/);
  });
});

describe('Dexcom Share parsing', () => {
  it('parses dates and readings', () => {
    expect(parseShareDate('Date(1700000000000-0500)')).toBe(1700000000000);
    expect(parseShareReadings([{ Value: 110, WT: 'Date(1700000000000)', Trend: 'FortyFiveDown' }])[0]).toMatchObject({ value: 110, trend: 'fortyFiveDown' });
  });
});

describe('demo devices', () => {
  it('share one virtual patient and move with simulated time', async () => {
    demoHub.reset();
    const ctx = { clock: systemClock, log: silentLogger, fetch: fakeFetch([]) };
    const pump = demoPump.create(demoPump.defaultSettings, ctx);
    const cgm = demoCgm.create(demoCgm.defaultSettings, ctx);
    const before = await cgm.readings(0);
    expect(before.length).toBeGreaterThan(50);
    await pump.setTempBasal(0, 30);
    demoHub.world()!.advance(10);
    const after = await cgm.readings(before.at(-1)!.date);
    expect(after).toHaveLength(2);
    expect((await pump.history(0)).some((d) => d.kind === 'tempBasal')).toBe(true);
    demoHub.reset();
  });

  it('registries list built-ins', () => {
    expect(createPumpRegistry().list().map((p) => p.meta.id)).toEqual(expect.arrayContaining(['demo-pump', 'nightscout-follower']));
    expect(createCgmRegistry().list().map((p) => p.meta.id)).toEqual(expect.arrayContaining(['demo-cgm', 'nightscout-cgm', 'dexcom-share']));
  });
});
