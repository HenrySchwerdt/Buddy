/** Eros driver safety: lost replies, unacknowledged messages, link loss, pod faults. Bench only (simulated pod). */
import { describe, expect, it } from 'vitest';
import { podStatusFlow } from './omnipod-eros-flows';
import { activateErosPod, makeErosRig } from './omnipod-eros-helpers';

const bolusSum = (h: { kind: string; units?: number }[]) => h.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + (d.units ?? 0) : s), 0);

describe('Omnipod Eros fault handling', () => {
  it('lost reply mid-bolus: the outcome is unknown, further dosing is refused, a later status settles it as delivered', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.loseReplies(true);
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(r.ok).toBe(false);
    expect(rig.bench.model.userBolusRequests).toEqual([1]); // the pod did run it
    expect((await rig.driver.history(0)).filter((d) => d.kind === 'bolus')).toEqual([]); // nothing unconfirmed in history
    expect((await rig.driver.status()).bolusing).toBe(true); // owed: treated as running
    expect(await rig.driver.bolus(0.5, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/i) });
    expect(await rig.driver.setTempBasal(1, 30)).toMatchObject({ ok: false });
    expect(rig.bench.model.userBolusRequests).toEqual([1]);

    rig.bench.loseReplies(false);
    await rig.advance(60_000);
    const s = await rig.driver.status();
    expect(s.bolusing).toBe(false);
    expect(bolusSum(await rig.driver.history(0))).toBeCloseTo(1, 5);
    expect(rig.bench.deliveredBolusUnits).toBeCloseTo(1, 5);
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
  });

  it('lost reply, but the pod never received the command: settled as not delivered', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.pod.dropNext = 1_000_000; // the pod hears nothing at all
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(r.ok).toBe(false);
    rig.bench.pod.dropNext = 0;
    await rig.advance(40_000);
    expect(bolusSum(await rig.driver.history(0))).toBe(0);
    expect((await rig.driver.status()).bolusing).toBe(false);
    expect(rig.bench.deliveredBolusUnits).toBe(0);
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
  });

  it('a pod that only acknowledges (no answer message) is an unknown outcome that a status resolves', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.ackOnlyNext(1);
    const r = await rig.driver.bolus(0.5, { automatic: false });
    // the reconnect status proves the pod received it: reported as success
    expect(r.ok).toBe(true);
    await rig.advance(30_000);
    await rig.driver.status();
    expect(bolusSum(await rig.driver.history(0))).toBeCloseTo(0.5, 5);
    expect(rig.bench.model.userBolusRequests).toEqual([0.5]);
  });

  it('cancel, suspend and cancel-bolus stay available while an outcome is unknown', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.loseReplies(true);
    await rig.driver.bolus(2, { automatic: false });
    rig.bench.loseReplies(false);
    const s = await rig.driver.suspend();
    expect(s.ok).toBe(true);
    await rig.advance(5_000);
    expect(bolusSum(await rig.driver.history(0))).toBeLessThan(2);
    expect(bolusSum(await rig.driver.history(0))).toBeLessThanOrEqual(rig.bench.deliveredBolusUnits + 0.001);
  });

  it('RileyLink out of range: commands fail cleanly and nothing is invented', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.driver.disconnect();
    rig.range.unreachable = true;
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect(rig.bench.model.userBolusRequests).toEqual([]);
    expect((await rig.driver.status()).bolusing).toBe(false);
    rig.range.unreachable = false;
    await rig.advance(40_000);
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
  });

  it('pod fault: delivery stops, the fault is recorded, the unconfirmed remainder is not reported', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    expect((await rig.driver.bolus(2, { automatic: false })).ok).toBe(true);
    await rig.advance(10_000); // 5 of 40 pulses
    rig.bench.injectFault(0x1c);
    await rig.advance(40_000);
    const s = await rig.driver.status();
    expect(s.suspended).toBe(true);
    expect(s.bolusing).toBe(false);
    expect(bolusSum(await rig.driver.history(0))).toBeLessThanOrEqual(rig.bench.deliveredBolusUnits + 0.001);
    expect(await rig.driver.bolus(0.5, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/fault/i) });
    expect((await podStatusFlow(rig.driver)).phase).toBe('faulted');
    expect((await podStatusFlow(rig.driver)).fault).toBeTruthy();
  });

  it('pod fault answer to a command is surfaced as a fault, not as a transport error', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.injectFault(0x1c);
    const r = await rig.driver.setTempBasal(1, 30);
    expect(r).toMatchObject({ ok: false });
    expect((await podStatusFlow(rig.driver)).phase).toBe('faulted');
  });

  it('link drop right after the command reaches the radio never over-reports', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    await rig.driver.connect();
    rig.ble.dropAfterWrites(1);
    await rig.driver.bolus(1, { automatic: false });
    await rig.advance(60_000);
    await rig.driver.connect().catch(() => undefined);
    await rig.advance(30_000);
    expect(bolusSum(await rig.driver.history(0))).toBeLessThanOrEqual(rig.bench.deliveredBolusUnits + 0.001);
  });

  it('an unknown outcome survives a restart: the new driver settles it from the pod', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.loseReplies(true);
    await rig.driver.bolus(1, { automatic: false });
    rig.bench.loseReplies(false);
    const second = rig.newDriver();
    expect((await second.status()).bolusing).toBe(true);
    await rig.advance(60_000);
    expect((await second.status()).bolusing).toBe(false);
    expect(bolusSum(await second.history(0))).toBeCloseTo(1, 5);
  });
});
