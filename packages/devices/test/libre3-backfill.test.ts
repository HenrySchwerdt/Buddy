/**
 * Reconnect backfill of the Libre 3 against the simulator: historical + clinical gap fill from the
 * saved watermark, de-duplication against realtime readings, retry policy and cancellation
 * (port of LibreLoop `requestBackfillIfNeeded`, MIT; commands from RoundWhiteDiscKit, MIT).
 */
import { describe, expect, it } from 'vitest';
import { backfillStartLifeCount } from '../src/libre3/backfill';
import { loadSensorState } from '../src/libre3';
import { FAST_TIMING, T0, minute, rig, waitFor } from './libre3-helpers';

const MIN = 60_000;

describe('backfillStartLifeCount', () => {
  it('starts at the watermark minus an overlap, never at 0', () => {
    expect(backfillStartLifeCount(500, 600)).toBe(490);
    expect(backfillStartLifeCount(8, 600)).toBe(5);
    expect(backfillStartLifeCount(null, 600)).toBe(420);
    expect(backfillStartLifeCount(null, 100)).toBe(5);
  });
});

describe('backfill after a reconnect', () => {
  it('fills the outage from historical pages and the clinical window without duplicating realtime readings', async () => {
    const r = await rig();
    await r.source.start();
    for (let i = 0; i < 5; i++) await minute(r, { mgdl: 100 }); // lifeCount 201..205, one reading at T0
    expect((await loadSensorState(r.h.secrets))!.lastLifeCount).toBe(205);
    await waitFor(() => r.sim.commands.length === 3, 'backfill of the first connection');
    const firstConnection = r.sim.commands.length;

    // 30 minutes out of range: the sensor keeps committing 5-minute values and per-minute records
    r.sim.drop();
    r.sim.lifeCount += 30;
    r.h.clock.advance(30 * MIN);
    for (let lc = 205; lc <= 230; lc += 5) r.sim.history.set(lc, 100 + (lc % 7));
    for (let lc = 206; lc <= 235; lc++) r.sim.clinical.set(lc, 100 + (lc % 7));
    await waitFor(() => r.sim.connections.length === 2 && r.source.status().phase === 'streaming', 'reconnect');

    await minute(r, { mgdl: 150 }); // first realtime frame (life count 236) triggers the backfill
    await waitFor(() => r.sim.commands.length === firstConnection + 3, 'both backfill passes');
    await new Promise((res) => setTimeout(res, 20));
    await r.source.idle();

    expect(r.sim.commands.slice(firstConnection)).toEqual([
      { stream: 'historical', fromLifeCount: 195 }, // watermark 205 minus the 10 minute overlap
      { stream: 'clinical', fromLifeCount: 206 }, // the recent 30 minutes only
      { stream: 'historical', fromLifeCount: 231 }, // pass 2 from the advanced watermark (236) minus 5
    ]);
    const readings = await r.source.readings(0);
    const lifeCounts = readings.map((x) => Math.round((x.date - T0) / MIN) + 201);
    expect(lifeCounts).toEqual([201, 205, 210, 215, 220, 225, 230, 236]);
    expect(readings.map((x) => x.value)).toEqual([100, ...[205, 210, 215, 220, 225, 230].map((lc) => 100 + (lc % 7)), 150]);
    // no two readings closer than the 2.5 minute de-duplication window
    for (let i = 1; i < readings.length; i++) expect(readings[i]!.date - readings[i - 1]!.date).toBeGreaterThan(150_000);
    expect((await loadSensorState(r.h.secrets))!.lastLifeCount).toBe(236);
  });

  it('keeps only the 5-minute grid of clinical records and skips minutes that already have a reading', async () => {
    const r = await rig({ lifeCount: 400 });
    await r.source.start();
    r.sim.clinical.set(380, 111);
    r.sim.clinical.set(381, 112);
    r.sim.clinical.set(395, 113);
    r.sim.clinical.set(399, 114);
    await minute(r, { mgdl: 120 }); // lc 401, from = 401-180 = 221, clinical from 371
    await waitFor(() => r.sim.commands.some((c) => c.stream === 'clinical'), 'clinical request');
    await new Promise((res) => setTimeout(res, 20));
    await r.source.idle();
    const readings = await r.source.readings(0);
    const byLifeCount = readings.map((x) => [Math.round((x.date - T0) / MIN) + 401, x.value]);
    expect(byLifeCount).toEqual([[380, 111], [395, 113], [401, 120]]);
  });

  it('retries a failed request on the next reading and gives up after three failures', async () => {
    const once = await rig({ settings: { minuteByMinute: true } });
    once.sim.failBackfillWrites = 1;
    await once.source.start();
    await minute(once);
    await minute(once);
    await waitFor(() => once.sim.commands.length >= 1, 'retried request');
    expect(once.sim.commands[0]).toMatchObject({ stream: 'historical' });
    expect(once.sim.failBackfillWrites).toBe(0);

    const never = await rig({ settings: { minuteByMinute: true } });
    never.sim.failBackfillWrites = 10;
    await never.source.start();
    for (let i = 0; i < 6; i++) await minute(never);
    expect(never.sim.failBackfillWrites).toBe(7); // exactly three attempts
    expect(never.sim.commands).toEqual([]);
    expect(never.h.logs.filter((l) => /historical backfill request failed/.test(l))).toHaveLength(3);
  });

  it('cancels the delayed second pass when the connection goes away', async () => {
    const r = await rig({ timing: { backfillPass2Ms: 5_000 } });
    await r.source.start();
    await minute(r);
    await waitFor(() => r.sim.commands.length === 2, 'first pass');
    await r.source.stop();
    await new Promise((res) => setTimeout(res, 100));
    expect(r.sim.commands).toHaveLength(2); // the delayed pass 2 never fires
  });

  it('does not request anything while the sensor is still warming up', async () => {
    const r = await rig({ lifeCount: 20 });
    await r.source.start();
    await minute(r, { mgdl: null });
    await minute(r, { mgdl: null });
    await new Promise((res) => setTimeout(res, 30));
    expect(r.sim.commands).toEqual([]);
    expect(FAST_TIMING.backfillPass2Ms).toBeGreaterThan(0);
  });
});
