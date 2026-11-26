import { describe, expect, it } from 'vitest';
import { silentLogger, type DeviceContext } from '@buddy/core';
import { parseXdripAppGroupJson, parseXdripDate, XDRIP_MAX_FUTURE_MS, XDRIP_MIN_POLL_MS, xdripCgm, xdripTrend, type XdripBridge, type XdripNativeReading } from '../src/xdrip';

const T0 = 1_800_000_000_000;

const iosBridge = (files: { json: string | null }, calls = { n: 0 }, configured = true): XdripBridge => ({
  platform: 'ios',
  isConfigured: async () => configured,
  readAppGroupJson: async () => {
    calls.n++;
    return files.json;
  },
});

function ctxWith(xdrip: XdripBridge | undefined, clock: { t: number }): DeviceContext {
  return { clock: { now: () => clock.t }, log: silentLogger, fetch: globalThis.fetch, ...(xdrip ? { xdrip } : {}) } as DeviceContext;
}

const row = (value: number, dateMs: number, extra: Record<string, unknown> = {}) => ({ Value: value, DT: `/Date(${dateMs})/`, direction: 'Flat', ...extra });

describe('xDrip parsing', () => {
  it('accepts the legacy array and the rich dictionary shape', () => {
    const arr = parseXdripAppGroupJson(JSON.stringify([row(110, T0), row(112, T0 + 300_000, { direction: 'FortyFiveUp' })]));
    const rich = parseXdripAppGroupJson(JSON.stringify({ recentReadings: [row(110, T0)], cgm: { status: {} } }));
    expect(arr.map((r) => r.value)).toEqual([110, 112]);
    expect(rich).toHaveLength(1);
  });

  it('parses dates with a time-zone suffix and rejects garbage', () => {
    expect(parseXdripDate('/Date(1462404576000)/')).toBe(1462404576000);
    expect(parseXdripDate('/Date(1462404576000+0200)/')).toBe(1462404576000);
    expect(parseXdripDate('2020-01-01')).toBeNull();
    expect(parseXdripDate(5)).toBeNull();
  });

  it('skips unusable rows and rows tagged for another source, but throws on a malformed payload', () => {
    const out = parseXdripAppGroupJson(JSON.stringify([row(100, T0), { Value: 'x', DT: '/Date(1)/' }, { Value: 90 }, row(95, T0 + 1, { from: 'Other' }), null, row(96, T0 + 2, { from: 'xDrip' })]));
    expect(out.map((r) => r.value)).toEqual([100, 96]);
    expect(() => parseXdripAppGroupJson('not json')).toThrow(/not valid JSON/);
    expect(() => parseXdripAppGroupJson('{"foo":1}')).toThrow(/unexpected shape/);
  });

  it('maps trends from names, numeric codes and numeric strings', () => {
    expect(xdripTrend({ direction: 'DoubleDown' })).toBe('doubleDown');
    expect(xdripTrend({ direction: 'NOT COMPUTABLE' })).toBe('unknown');
    expect(xdripTrend({ trend: 1 })).toBe('doubleUp');
    expect(xdripTrend({ trend: 4 })).toBe('flat');
    expect(xdripTrend({ trend: 7 })).toBe('doubleDown');
    expect(xdripTrend({})).toBe('unknown');
    const [r] = parseXdripAppGroupJson(JSON.stringify([{ Value: 100, DT: `/Date(${T0})/`, Trend: '3' }]));
    expect(xdripTrend(r!)).toBe('fortyFiveUp');
  });
});

describe('xdripCgm (iOS app group)', () => {
  it('declares its meta', () => {
    expect(xdripCgm.meta).toMatchObject({ id: 'xdrip', maturity: 'experimental', transport: 'native-module' });
  });

  it('returns real readings with xDrip timestamps, newest after since, oldest first', async () => {
    const clock = { t: T0 + 600_000 };
    const files = { json: JSON.stringify([row(120, T0 + 300_000), row(110, T0)]) };
    const cgm = xdripCgm.create({}, ctxWith(iosBridge(files), clock));
    await cgm.start();
    const all = await cgm.readings(0);
    expect(all.map((r) => [r.date, r.value, r.source, r.trend])).toEqual([
      [T0, 110, 'xdrip', 'flat'],
      [T0 + 300_000, 120, 'xdrip', 'flat'],
    ]);
    expect((await cgm.readings(T0)).map((r) => r.value)).toEqual([120]);
  });

  it('leaves old data old (no re-stamping) when xDrip stops delivering', async () => {
    const clock = { t: T0 + 3_600_000 };
    const cgm = xdripCgm.create({}, ctxWith(iosBridge({ json: JSON.stringify([row(100, T0)]) }), clock));
    await cgm.start();
    clock.t += 10 * XDRIP_MIN_POLL_MS;
    expect((await cgm.readings(0)).map((r) => r.date)).toEqual([T0]);
  });

  it('dedupes by timestamp across polls', async () => {
    const clock = { t: T0 + 1_000 };
    const files = { json: JSON.stringify([row(100, T0)]) };
    const cgm = xdripCgm.create({}, ctxWith(iosBridge(files), clock));
    await cgm.start();
    files.json = JSON.stringify([row(101, T0), row(105, T0 + 300_000)]);
    clock.t = T0 + 300_000 + XDRIP_MIN_POLL_MS;
    const out = await cgm.readings(0);
    expect(out.map((r) => r.date)).toEqual([T0, T0 + 300_000]);
    expect(out[0]!.value).toBe(101);
  });

  it('rejects readings more than 60 s in the future but keeps ones within the tolerance', async () => {
    const clock = { t: T0 };
    const files = { json: JSON.stringify([row(100, T0 + XDRIP_MAX_FUTURE_MS), row(101, T0 + XDRIP_MAX_FUTURE_MS + 1), row(102, T0 - 60_000)]) };
    const cgm = xdripCgm.create({}, ctxWith(iosBridge(files), clock));
    await cgm.start();
    expect((await cgm.readings(0)).map((r) => r.value)).toEqual([102, 100]);
  });

  it('drops implausible values and does not fabricate anything from an empty store', async () => {
    const clock = { t: T0 };
    const files: { json: string | null } = { json: JSON.stringify([row(0, T0 - 1000), row(20, T0 - 2000), row(500, T0 - 3000)]) };
    const cgm = xdripCgm.create({}, ctxWith(iosBridge(files), clock));
    await cgm.start();
    expect(await cgm.readings(0)).toEqual([]);
    files.json = null;
    clock.t += XDRIP_MIN_POLL_MS;
    expect(await cgm.readings(0)).toEqual([]);
  });

  it('throttles native reads to one per 30 s', async () => {
    const clock = { t: T0 };
    const calls = { n: 0 };
    const cgm = xdripCgm.create({}, ctxWith(iosBridge({ json: JSON.stringify([row(100, T0 - 1000)]) }, calls), clock));
    await cgm.start();
    await cgm.readings(0);
    await cgm.readings(0);
    expect(calls.n).toBe(1);
    clock.t += XDRIP_MIN_POLL_MS;
    await cgm.readings(0);
    expect(calls.n).toBe(2);
  });

  it('surfaces a malformed payload instead of swallowing it', async () => {
    const clock = { t: T0 };
    const cgm = xdripCgm.create({}, ctxWith(iosBridge({ json: '{oops' }), clock));
    await expect(cgm.start()).rejects.toThrow(/not valid JSON/);
  });

  it('explains a missing bridge or a missing App Group', async () => {
    const clock = { t: T0 };
    await expect(xdripCgm.create({}, ctxWith(undefined, clock)).start()).rejects.toThrow(/no xDrip bridge/);
    await expect(xdripCgm.create({}, ctxWith(iosBridge({ json: null }, { n: 0 }, false), clock)).start()).rejects.toThrow(/App Group/);
  });
});

describe('xdripCgm (Android broadcast)', () => {
  const androidBridge = () => {
    const buffer: XdripNativeReading[] = [];
    let listener: ((r: XdripNativeReading) => void) | null = null;
    const bridge: XdripBridge = {
      platform: 'android',
      isConfigured: async () => true,
      bufferedReadings: async () => buffer,
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    };
    return { bridge, buffer, emit: (r: XdripNativeReading) => listener?.(r), hasListener: () => listener !== null };
  };

  it('merges buffered readings with live broadcasts and dedupes them', async () => {
    const clock = { t: T0 + 600_000 };
    const a = androidBridge();
    a.buffer.push({ value: 99.6, date: T0, direction: 'SingleDown' });
    const cgm = xdripCgm.create({}, ctxWith(a.bridge, clock));
    await cgm.start();
    a.emit({ value: 104, date: T0 + 300_000, direction: 'Flat' });
    a.emit({ value: 104, date: T0 + 300_000, direction: 'Flat' });
    const out = await cgm.readings(0);
    expect(out.map((r) => [r.date, r.value, r.trend])).toEqual([
      [T0, 100, 'singleDown'],
      [T0 + 300_000, 104, 'flat'],
    ]);
  });

  it('ignores future-dated broadcasts and stops listening on stop()', async () => {
    const clock = { t: T0 };
    const a = androidBridge();
    const cgm = xdripCgm.create({}, ctxWith(a.bridge, clock));
    await cgm.start();
    a.emit({ value: 100, date: T0 + 120_000 });
    expect(await cgm.readings(0)).toEqual([]);
    await cgm.stop();
    expect(a.hasListener()).toBe(false);
  });
});
