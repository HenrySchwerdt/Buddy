import { describe, expect, it } from 'vitest';
import type { InsulinDose } from '@buddy/core';
import { START, flush, rig, up } from './insight-helpers';

const temps = (h: readonly InsulinDose[]) => h.filter((d): d is Extract<InsulinDose, { kind: 'tempBasal' }> => d.kind === 'tempBasal');
const tbrCommands = (r: ReturnType<typeof rig>) => r.sim.executed.filter((e) => e.op === 'setTBR');

describe('Insight temp basal', () => {
  it('converts the absolute rate to a percentage of the profile, rounded down to 10 %', async () => {
    const r = rig();
    await up(r);
    expect((await r.driver.setTempBasal(0.5, 30)).ok).toBe(true);
    expect(tbrCommands(r)[0]?.args).toMatchObject({ percent: 50, duration: 30 });
    expect((await r.driver.setTempBasal(1.58, 45)).ok).toBe(true); // 158 % -> 150 %
    expect(tbrCommands(r)[1]?.args).toMatchObject({ percent: 150, duration: 45 });
    const s = await r.driver.status();
    expect(s.tempBasal?.rate).toBeCloseTo(1.5, 6);
    expect(s.tempBasal?.durationMin).toBe(45);
  });

  it('normalises the duration down to 15 minute steps and never below 15', async () => {
    const r = rig();
    await up(r);
    await r.driver.setTempBasal(0.5, 40);
    await r.driver.setTempBasal(0.5, 5);
    expect(tbrCommands(r).map((c) => c.args.duration)).toEqual([30, 15]);
  });

  it('a request equal to the scheduled rate stops a running temp basal instead of setting one', async () => {
    const r = rig();
    await up(r);
    await r.driver.setTempBasal(0.5, 30);
    expect((await r.driver.setTempBasal(1.0, 30)).ok).toBe(true);
    expect(tbrCommands(r)).toHaveLength(1);
    expect(r.sim.executed.some((e) => e.op === 'cancelTBR')).toBe(true);
    expect((await r.driver.status()).tempBasal).toBeNull();
  });

  it('records the temp basal only after the bridge confirmed it and truncates it when cancelled', async () => {
    const r = rig();
    await up(r);
    r.sim.failNextDosing({ code: 'pumpBusy' });
    expect((await r.driver.setTempBasal(0.5, 30)).ok).toBe(false);
    expect(temps(await r.driver.history(0))).toHaveLength(0);
    await r.driver.setTempBasal(0.5, 30);
    expect(temps(await r.driver.history(0))).toMatchObject([{ rate: 0.5, durationMin: 30 }]);
    await r.advance(10 * 60_000);
    await r.driver.cancelTempBasal();
    const t = temps(await r.driver.history(0));
    expect(t).toHaveLength(1);
    expect(t[0]!.durationMin).toBeCloseTo(10, 3);
  });

  it('notices a temp basal that ended early on the pump and one that ran out by itself', async () => {
    const r = rig();
    await up(r);
    await r.driver.setTempBasal(0.5, 30);
    await r.advance(5 * 60_000);
    r.sim.endTbrOnPump();
    await r.driver.status();
    await r.advance(1000);
    const t = temps(await r.driver.history(0));
    expect(t).toHaveLength(1);
    expect(t[0]!.durationMin).toBeCloseTo(5, 0);
    await r.driver.setTempBasal(0.5, 15);
    await r.advance(16 * 60_000);
    expect((await r.driver.status()).tempBasal).toBeNull();
    const all = temps(await r.driver.history(0));
    expect(all).toHaveLength(2);
    expect(all[1]!.durationMin).toBe(15);
  });

  it('imports a temp basal programmed on the pump once, when it has ended', async () => {
    const r = rig();
    await up(r);
    r.sim.programTbrOnPump(200, 30);
    await flush();
    expect((await r.driver.status()).tempBasal?.rate).toBeCloseTo(2, 6);
    await r.advance(31 * 60_000);
    await r.driver.status();
    for (let i = 0; i < 3; i++) await r.driver.history(0);
    expect(temps(await r.driver.history(0))).toMatchObject([{ rate: 2, durationMin: 30 }]);
  });

  it('shortens the duration so the temp basal ends where the scheduled rate changes', async () => {
    // UTC+1: 09:00 UTC is 10:00 local; the next hour is twice as high.
    const profile = Array.from({ length: 24 }, (_, h) => (h === 11 ? 2.0 : 1.0)).join(',');
    const r = rig({ settings: { basalProfile: profile } });
    r.setNow(START + 30 * 60_000); // 10:30 local
    await up(r);
    await r.driver.setTempBasal(0.5, 60);
    expect(tbrCommands(r)[0]?.args).toMatchObject({ percent: 50, duration: 30 });
  });

  it('close to a rate change it takes the highest rate of the window as the base, so the request is never exceeded', async () => {
    const profile = Array.from({ length: 24 }, (_, h) => (h === 11 ? 2.0 : 1.0)).join(',');
    const r = rig({ settings: { basalProfile: profile } });
    r.setNow(START + 50 * 60_000); // 10:50 local, change in 10 minutes
    await up(r);
    await r.driver.setTempBasal(1.0, 30);
    expect(tbrCommands(r)[0]?.args).toMatchObject({ percent: 50, duration: 15 });
    const t = temps(await r.driver.history(0));
    expect(t.map((d) => [d.rate, d.durationMin])).toEqual([
      [0.5, 10],
      [1, 5],
    ]);
    expect(Math.max(...t.map((d) => d.rate))).toBeLessThanOrEqual(1.0);
  });

  it('refuses rates above the maximum and without a usable basal profile', async () => {
    const r = rig({ settings: { maxBasal: 2 } });
    await up(r);
    expect((await r.driver.setTempBasal(3, 30)).ok).toBe(false);
    expect(tbrCommands(r)).toHaveLength(0);
    const none = rig({ settings: { basalProfile: '' } });
    await up(none);
    const res = await none.driver.setTempBasal(0.5, 30);
    expect(res).toMatchObject({ ok: false });
    expect(tbrCommands(none)).toHaveLength(0);
  });

  it('does not raise insulin until the pump is known to hold the profile, but still allows reductions', async () => {
    const r = rig();
    r.sim.failNextDosing({ code: 'verifyFailed' }, true); // the first profile write is not confirmed
    await r.driver.connect();
    await r.driver.status();
    expect(r.driver.info().profileConfirmed).toBe(false);
    expect((await r.driver.setTempBasal(1.5, 30)).ok).toBe(false);
    expect((await r.driver.setTempBasal(0.5, 30)).ok).toBe(true);
    await r.driver.cancelTempBasal();
    expect((await r.driver.syncBasalProfile()).ok).toBe(true);
    expect(r.driver.info().profileConfirmed).toBe(true);
    expect((await r.driver.setTempBasal(1.5, 30)).ok).toBe(true);
  });

  it('refuses a percentage when the pump reports another scheduled rate than the profile', async () => {
    const r = rig();
    await up(r);
    r.sim.basal = Array.from({ length: 24 }, () => 2.0);
    await r.advance(61_000);
    const res = await r.driver.setTempBasal(0.5, 30);
    expect(res.ok).toBe(false);
    expect(tbrCommands(r)).toHaveLength(0);
    expect((await r.driver.setTempBasal(0, 30)).ok).toBe(true); // a zero temp is always safe
    expect(tbrCommands(r)).toHaveLength(1);
  });

  it('suspend ends the temp basal, is recorded open-ended and closed by resume', async () => {
    const r = rig();
    await up(r);
    await r.driver.setTempBasal(0.5, 30);
    await r.advance(5 * 60_000);
    expect((await r.driver.suspend()).ok).toBe(true);
    await r.advance(10 * 60_000);
    let h = await r.driver.history(0);
    expect(temps(h)[0]!.durationMin).toBeCloseTo(5, 3);
    expect(h.find((d) => d.kind === 'suspend')).toMatchObject({ durationMin: 10 });
    expect((await r.driver.status()).suspended).toBe(true);
    expect((await r.driver.resume()).ok).toBe(true);
    await r.advance(5 * 60_000);
    h = await r.driver.history(0);
    expect(h.find((d) => d.kind === 'suspend')).toMatchObject({ durationMin: 10 });
    expect((await r.driver.status()).suspended).toBe(false);
  });

  it('records a suspend that was done on the pump', async () => {
    const r = rig();
    await up(r);
    r.sim.mode = 'stopped';
    await r.advance(61_000);
    expect((await r.driver.status()).suspended).toBe(true);
    expect((await r.driver.history(0)).some((d) => d.kind === 'suspend')).toBe(true);
  });
});
