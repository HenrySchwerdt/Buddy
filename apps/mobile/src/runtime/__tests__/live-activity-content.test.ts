import { describe, expect, it } from 'vitest';
import { MINUTE, type GlucoseReading } from '@buddy/core';
import { DEFAULT_LIVE_ACTIVITY_SETTINGS, STALE_AFTER_MS, arrowFromDelta, buildStatusContent, chartSamples, notificationText, type StatusInput } from '../live-activity-content';

const NOW = 1_700_000_000_000;
const reading = (minAgo: number, value: number, extra: Partial<GlucoseReading> = {}): GlucoseReading => ({ date: NOW - minAgo * MINUTE, value, source: 'test', ...extra });

const input = (o: Partial<StatusInput> = {}): StatusInput => ({ glucose: [reading(10, 100), reading(5, 110)], iob: 1.234, cob: 24.6, lastLoopAt: NOW - 2 * MINUTE, units: 'mg/dL', low: 70, high: 180, now: NOW, ...o });

describe('buildStatusContent', () => {
  it('formats glucose, delta, IOB, COB and loop time', () => {
    const c = buildStatusContent(input(), DEFAULT_LIVE_ACTIVITY_SETTINGS);
    expect(c).toMatchObject({ glucose: '110', unit: 'mg/dL', delta: '+10', iob: '1.2', cob: '25', stale: false, glucoseMgdl: 110 });
    expect(c.readingAt).toBe(Math.floor((NOW - 5 * MINUTE) / 1000));
    expect(c.lastLoopAt).toBe(Math.floor((NOW - 2 * MINUTE) / 1000));
    expect(c.arrow).toBe('↑');
  });

  it('prefers the CGM trend and formats mmol/L', () => {
    const c = buildStatusContent(input({ units: 'mmol/L', glucose: [reading(5, 90), reading(0, 108, { trend: 'flat' })] }), DEFAULT_LIVE_ACTIVITY_SETTINGS);
    expect(c.arrow).toBe('→');
    expect(c.glucose).toBe('6.0');
    expect(c.delta).toBe('+1.0');
  });

  it('marks old readings stale and handles no data', () => {
    expect(buildStatusContent(input({ glucose: [reading(STALE_AFTER_MS / MINUTE + 1, 100)] }), DEFAULT_LIVE_ACTIVITY_SETTINGS).stale).toBe(true);
    const none = buildStatusContent(input({ glucose: [], iob: null, cob: null, lastLoopAt: null }), DEFAULT_LIVE_ACTIVITY_SETTINGS);
    expect(none).toMatchObject({ glucose: '--', stale: true, iob: '--', cob: '--', readingAt: 0, lastLoopAt: 0 });
  });

  it('ignores implausible values and skips delta across a gap', () => {
    const c = buildStatusContent(input({ glucose: [reading(60, 100), reading(0, 150), reading(1, 20)] }), DEFAULT_LIVE_ACTIVITY_SETTINGS);
    expect(c.glucoseMgdl).toBe(150);
    expect(c.delta).toBe('');
  });

  it('only includes the chart in the detailed view', () => {
    const readings = Array.from({ length: 40 }, (_, i) => reading(i * 5, 100 + i));
    expect(buildStatusContent(input({ glucose: readings }), DEFAULT_LIVE_ACTIVITY_SETTINGS).chartValues).toEqual([]);
    const detailed = buildStatusContent(input({ glucose: readings }), { ...DEFAULT_LIVE_ACTIVITY_SETTINGS, lockScreenView: 'detailed' });
    expect(detailed.chartValues.length).toBeGreaterThan(10);
    expect(detailed.chartValues.length).toBe(detailed.chartAges.length);
    expect(detailed.chartAges.at(-1)).toBe(0);
    const hidden = buildStatusContent(input({ glucose: readings }), { ...DEFAULT_LIVE_ACTIVITY_SETTINGS, lockScreenView: 'detailed', showChart: false });
    expect(hidden.chartValues).toEqual([]);
  });
});

describe('arrowFromDelta and chartSamples', () => {
  it.each([
    [20, '⇈'],
    [12, '↑'],
    [6, '↗'],
    [0, '→'],
    [-6, '↘'],
    [-12, '↓'],
    [-20, '⇊'],
  ])('delta %i per 5 min', (delta, arrow) => expect(arrowFromDelta(delta)).toBe(arrow));

  it('keeps at most 36 samples within three hours, oldest first', () => {
    const readings = Array.from({ length: 200 }, (_, i) => reading(i, 100));
    const { ages, values } = chartSamples(readings, NOW);
    expect(values.length).toBeLessThanOrEqual(36);
    expect(Math.max(...ages)).toBeLessThanOrEqual(180);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
  });
});

describe('notificationText', () => {
  it('puts glucose, trend and delta in the title and IOB, COB, loop below', () => {
    const t = notificationText(buildStatusContent(input(), DEFAULT_LIVE_ACTIVITY_SETTINGS));
    expect(t.title).toBe('110 mg/dL ↑  +10');
    expect(t.text).toContain('IOB 1.2 U');
    expect(t.text).toContain('COB 25 g');
    expect(t.text).toContain('Loop ');
    expect(t.when).toBe(NOW - 5 * MINUTE);
  });

  it('flags old data and missing data', () => {
    expect(notificationText(buildStatusContent(input({ glucose: [reading(30, 100)] }), DEFAULT_LIVE_ACTIVITY_SETTINGS)).title).toContain('(old)');
    expect(notificationText(buildStatusContent(input({ glucose: [], lastLoopAt: null }), DEFAULT_LIVE_ACTIVITY_SETTINGS))).toMatchObject({ title: 'No glucose', text: expect.stringContaining('Loop not run yet') });
  });
});
