// Fault tests for the port of OmnipodKit (MIT License, (c) LoopKit Authors).
/**
 * Fault injection for the Omnipod DASH driver: lost links and lost answers around commands,
 * unconfirmed commands, pod rejections and pod faults. The invariant under test: a command is
 * `ok: true` only when the pod confirmed it, and `history()` never contains more insulin than
 * the pod confirmed as delivered. Bench scenario only (simulated pod with water).
 */
import { describe, expect, it } from 'vitest';
import type { InsulinDose } from '@buddy/core';
import { activate, makeRig, type Rig } from './omnipod-helpers';
import { PodProgress } from '../src/omnipod/common';
import { readPodStatus } from '../src/omnipod';

const bolusUnits = (h: readonly InsulinDose[]): number => h.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + d.units : s), 0);
const near = (a: number, b: number) => Math.abs(a - b) < 0.001;

async function activeRig(): Promise<Rig> {
  const rig = makeRig();
  await activate(rig);
  return rig;
}

/** Number of data packets one bolus command takes on the link (learned from a real exchange). */
async function dataPacketsPerCommand(rig: Rig): Promise<number> {
  const before = rig.ble.writes.length;
  expect((await rig.driver.bolus(0.05, { automatic: false })).ok).toBe(true);
  const writes = rig.ble.writes.slice(before);
  // [RTS(cmd), data..., then CTS/SUCCESS(cmd) of the response]
  expect(writes[0]!.data[0]).toBe(0x00);
  let k = 0;
  for (const w of writes.slice(1)) {
    if (w.characteristic.toLowerCase().includes('2442')) k += 1;
    else break;
  }
  await rig.advance(5_000);
  await rig.driver.status();
  return k;
}

describe('lost link around a bolus', () => {
  it('link lost before the command left: ok:false, nothing recorded, nothing delivered', async () => {
    const rig = await activeRig();
    await rig.driver.connect();
    rig.ble.dropAfterWrites(1); // right after the RTS
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(r.ok).toBe(false);
    await rig.advance(60_000);
    expect(rig.sim.deliveredBolusUnits).toBe(0);
    expect(bolusUnits(await rig.driver.history(0))).toBe(0);
    // and the driver is usable again afterwards
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
  });

  it('link lost right after the command reached the pod: resolved by the pod status, never over-reported', async () => {
    const rig = await activeRig();
    const k = await dataPacketsPerCommand(rig);
    expect(k).toBeGreaterThan(0);
    await rig.driver.connect();
    const sessionsBefore = rig.sim.sessionsEstablished;
    rig.ble.dropAfterWrites(1 + k); // the pod has the whole command, the answer never arrives
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(rig.sim.sessionsEstablished).toBeGreaterThan(sessionsBefore); // the driver resynchronised on a fresh session
    // the pod got it: it is delivering, and the driver learned that from the pod's status
    expect(r.ok).toBe(true);
    for (let i = 0; i < 24; i++) {
      const hist = bolusUnits(await rig.driver.history(0));
      expect(hist).toBeLessThanOrEqual(rig.sim.deliveredBolusUnits + 1e-9); // never beyond what the pod delivered
      await rig.advance(2_000);
      await rig.driver.status();
    }
    expect(near(bolusUnits(await rig.driver.history(0)), rig.sim.deliveredBolusUnits)).toBe(true);
    expect(near(rig.sim.deliveredBolusUnits, 1.05)).toBe(true);
  });

  it('answer lost (pod executed the command): recovered through the last programming message number', async () => {
    const rig = await activeRig();
    await rig.driver.connect();
    rig.sim.dropNextResponses(1);
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(r.ok).toBe(true);
    expect(rig.logs.some((l) => /outcome of the bolus command is unknown/.test(l))).toBe(true);
    expect((await rig.driver.status()).bolusing).toBe(true);
    await rig.advance(10_000);
    const status = await rig.driver.status();
    expect(status.bolusing).toBe(true);
    const confirmed = bolusUnits(await rig.driver.history(0));
    expect(confirmed).toBeGreaterThan(0.2);
    expect(confirmed).toBeLessThanOrEqual(rig.sim.deliveredBolusUnits + 1e-9);
    await rig.advance(40_000);
    expect((await rig.driver.status()).bolusing).toBe(false);
    expect(near(bolusUnits(await rig.driver.history(0)), 1)).toBe(true);
  });

  it('answer lost and pod unreachable: ok:false, no insulin reported, further dosing refused until resolved', async () => {
    const rig = await activeRig();
    await rig.driver.connect();
    rig.sim.dropNextResponses(1);
    rig.range.unreachable = true;
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/unknown/i);
    await rig.advance(20_000);
    // the pod is delivering, the driver cannot know: it must not report anything it did not confirm
    expect(rig.sim.deliveredBolusUnits).toBeGreaterThan(0.3);
    expect(bolusUnits(await rig.driver.history(0))).toBe(0);
    // and it must not stack more insulin on top of an unknown command
    const second = await rig.driver.bolus(0.5, { automatic: false });
    expect(second.ok).toBe(false);
    expect((await rig.driver.setTempBasal(2, 30)).ok).toBe(false);
    // cancelling is always allowed to fail safely too, but never reports success without the pod
    rig.range.unreachable = false;
    await rig.driver.status(); // reconnects, resolves the pending command from the pod's status
    const confirmed = bolusUnits(await rig.driver.history(0));
    expect(confirmed).toBeGreaterThan(0.3);
    expect(confirmed).toBeLessThanOrEqual(rig.sim.deliveredBolusUnits + 1e-9);
    await rig.advance(40_000);
    await rig.driver.status();
    expect(near(bolusUnits(await rig.driver.history(0)), 1)).toBe(true);
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true); // resolved and finished: dosing is possible again
  });

  it('a pod that did not receive the command is detected by its status (not recorded, ok:false)', async () => {
    const rig = await activeRig();
    await rig.driver.connect();
    rig.ble.failNextWrite(); // the RTS write fails before anything reaches the pod
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(r.ok).toBe(false);
    await rig.advance(20_000);
    expect(rig.sim.deliveredBolusUnits).toBe(0);
    expect(bolusUnits(await rig.driver.history(0))).toBe(0);
  });
});

describe('cancel and partial delivery', () => {
  it('records exactly what the pod delivered when the bolus is cancelled', async () => {
    const rig = await activeRig();
    expect((await rig.driver.bolus(1, { automatic: false })).ok).toBe(true);
    await rig.advance(11_000); // 5 pulses of 2 s
    const c = await rig.driver.cancelBolus();
    expect(c.ok).toBe(true);
    const delivered = rig.sim.deliveredBolusUnits;
    expect(delivered).toBeGreaterThan(0.2);
    expect(delivered).toBeLessThan(0.4);
    expect(near(bolusUnits(await rig.driver.history(0)), delivered)).toBe(true);
    expect(c.ok && c.dose && c.dose.kind === 'bolus' ? near(c.dose.units, delivered) : false).toBe(true);
    await rig.advance(60_000);
    expect(near(rig.sim.deliveredBolusUnits, delivered)).toBe(true); // it really stopped
    expect((await rig.driver.status()).bolusing).toBe(false);
  });

  it('suspend stops a running bolus and truncates the temp basal', async () => {
    const rig = await activeRig();
    expect((await rig.driver.setTempBasal(2, 60)).ok).toBe(true);
    await rig.advance(10 * 60_000);
    expect((await rig.driver.suspend()).ok).toBe(true);
    const hist = await rig.driver.history(0);
    const temp = hist.find((d) => d.kind === 'tempBasal');
    expect(temp && temp.kind === 'tempBasal' ? temp.durationMin : -1).toBeCloseTo(10, 0);
    expect(hist.some((d) => d.kind === 'suspend')).toBe(true);
    const s = await rig.driver.status();
    expect(s.suspended).toBe(true);
    expect(s.tempBasal).toBeNull();
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(false);
  });
});

describe('rejections and limits', () => {
  it('a pod that rejects a command yields ok:false and records nothing', async () => {
    const rig = await activeRig();
    rig.sim.model.rejectCommands = 0x08;
    expect((await rig.driver.bolus(1, { automatic: false })).ok).toBe(false);
    expect((await rig.driver.setTempBasal(2, 30)).ok).toBe(false);
    rig.sim.model.rejectCommands = null;
    expect(await rig.driver.history(0)).toEqual([]);
    expect((await rig.driver.status()).tempBasal).toBeNull();
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true); // the failed commands left no pending state
  });

  it('keeps the pod limits: bolus 30 U, basal 30 U/h, temp basal 12 h', async () => {
    const rig = await activeRig();
    expect(await rig.driver.bolus(30.05, { automatic: false })).toMatchObject({ ok: false });
    expect(await rig.driver.bolus(0.04, { automatic: false })).toMatchObject({ ok: false });
    expect(await rig.driver.bolus(Number.NaN, { automatic: false })).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(30.5, 30)).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(-1, 30)).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(1, 721)).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(1, 0)).toMatchObject({ ok: false });
    expect(rig.sim.received.filter((m) => m.blocks[0]!.type === 'setInsulinSchedule')).toHaveLength(3); // only the prime, basal and cannula setup commands
    expect(rig.sim.deliveredBolusUnits).toBe(0);
  });

  it('refuses a second bolus while one runs and a temp basal while bolusing', async () => {
    const rig = await activeRig();
    expect((await rig.driver.bolus(1, { automatic: false })).ok).toBe(true);
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(false);
    expect((await rig.driver.setTempBasal(1, 30)).ok).toBe(false);
    expect(near(rig.sim.model.deliveredUserBolusUnits, 0)).toBe(true);
    await rig.advance(60_000);
    expect(near(rig.sim.deliveredBolusUnits, 1)).toBe(true);
  });

  it('rounds the temp basal to the pod grid and records what was enacted', async () => {
    const rig = await activeRig();
    expect((await rig.driver.setTempBasal(1.234, 44)).ok).toBe(true);
    const hist = await rig.driver.history(0);
    const t = hist.find((d) => d.kind === 'tempBasal');
    expect(t).toMatchObject({ kind: 'tempBasal', rate: 1.2, durationMin: 30 });
    const s = await rig.driver.status();
    expect(s.tempBasal).toMatchObject({ rate: 1.2, durationMin: 30 });
  });

  it('replaces a running temp basal and truncates the first one', async () => {
    const rig = await activeRig();
    expect((await rig.driver.setTempBasal(2, 60)).ok).toBe(true);
    await rig.advance(15 * 60_000);
    expect((await rig.driver.setTempBasal(0.5, 30)).ok).toBe(true);
    const temps = (await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal');
    expect(temps).toHaveLength(2);
    expect(temps[0]).toMatchObject({ rate: 2 });
    expect(temps[0]!.kind === 'tempBasal' ? temps[0]!.durationMin : -1).toBeCloseTo(15, 0);
    expect(temps[1]).toMatchObject({ rate: 0.5, durationMin: 30 });
    expect((await rig.driver.cancelTempBasal()).ok).toBe(true);
    expect((await rig.driver.status()).tempBasal).toBeNull();
  });

  it('records a zero temp basal as 0 U/h', async () => {
    const rig = await activeRig();
    expect((await rig.driver.setTempBasal(0, 30)).ok).toBe(true);
    expect((await rig.driver.history(0)).find((d) => d.kind === 'tempBasal')).toMatchObject({ rate: 0 });
  });
});

describe('pod faults', () => {
  it('a fault during a bolus freezes the delivered amount and stops all delivery', async () => {
    const rig = await activeRig();
    expect((await rig.driver.bolus(2, { automatic: false })).ok).toBe(true);
    await rig.advance(10_000);
    rig.sim.injectFault(0x14); // occlusion
    const delivered = rig.sim.deliveredBolusUnits;
    await rig.advance(60_000);
    const s = await rig.driver.status();
    expect(s.bolusing).toBe(false);
    expect(s.suspended).toBe(true);
    expect(near(bolusUnits(await rig.driver.history(0)), delivered)).toBe(true);
    const st = await readPodStatus(rig.driver);
    expect(st.phase).toBe('faulted');
    expect(st.fault).toMatch(/occluded/i);
    expect(st.podProgress).toBe(PodProgress.faultEventOccurred);
    const r = await rig.driver.bolus(0.5, { automatic: false });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/fault/i);
    expect((await rig.driver.resume()).ok).toBe(false);
  });

  it('persists the fault across a restart', async () => {
    const rig = await activeRig();
    rig.sim.injectFault(0x1c);
    await rig.advance(40_000);
    await rig.driver.status();
    const again = rig.newDriver();
    expect((await readPodStatus(again)).phase).toBe('faulted');
    expect((await again.status()).suspended).toBe(true);
  });
});

describe('secrets', () => {
  it('never logs the long term key or the session keys', async () => {
    const rig = await activeRig();
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    rig.sim.dropNextResponses(1);
    await rig.advance(30_000);
    await rig.driver.bolus(0.5, { automatic: false });
    const stored = JSON.parse((await rig.secrets.get('omnipod-dash/pod'))!);
    const secretsInStore: string[] = [stored.ltk, stored.transport.ck, stored.transport.noncePrefix];
    expect(secretsInStore.every((s) => typeof s === 'string' && s.length >= 16)).toBe(true);
    const log = rig.allLogs.join('\n').toLowerCase();
    for (const s of secretsInStore) expect(log).not.toContain(s.toLowerCase());
  });
});

describe('restart', () => {
  it('a restarted driver keeps tracking a running bolus', async () => {
    const rig = await activeRig();
    expect((await rig.driver.bolus(1, { automatic: true })).ok).toBe(true);
    await rig.advance(10_000);
    await rig.driver.status();
    const again = rig.newDriver();
    expect((await again.status()).bolusing).toBe(true);
    await rig.advance(40_000);
    expect((await again.status()).bolusing).toBe(false);
    const hist = await again.history(0);
    expect(hist.filter((d) => d.kind === 'smb')).toHaveLength(1);
    expect(near(bolusUnits(hist), 1)).toBe(true);
  });
});
