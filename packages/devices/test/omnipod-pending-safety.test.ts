/**
 * Regression tests for review findings in the Omnipod drivers (DASH and Eros share the dose ledger):
 * unresolved pending commands must not vanish from the history, a pending record must be durable
 * before anything is sent, a cancel must reach the pod when only the pod status shows a temp
 * basal, and temp basal durations floor to the pod's 30-minute steps. Bench only (simulated pods).
 */
import { describe, expect, it } from 'vitest';
import type { CommandResult, InsulinDose, PumpDriver, SecretStore } from '@buddy/core';
import { activate, makeRig } from './omnipod-helpers';
import { activateErosPod, makeErosRig } from './omnipod-eros-helpers';

interface Harness {
  readonly name: string;
  readonly key: string;
  readonly driver: PumpDriver;
  readonly secrets: SecretStore;
  readonly logs: string[];
  readonly allLogs: string[];
  readonly clock: { t: number };
  advance(ms: number): Promise<void>;
  newDriver(): PumpDriver;
  /** units the pod delivered as user bolus */
  delivered(): number;
  tempRunning(): boolean;
}

async function dashHarness(): Promise<Harness> {
  const rig = makeRig();
  await activate(rig);
  return {
    name: 'DASH',
    key: 'omnipod-dash/pod',
    driver: rig.driver,
    secrets: rig.secrets,
    logs: rig.logs,
    allLogs: rig.allLogs,
    clock: rig.clock,
    advance: rig.advance,
    newDriver: rig.newDriver,
    delivered: () => rig.sim.deliveredBolusUnits,
    tempRunning: () => (rig.sim.model as unknown as { temp: unknown }).temp !== null,
  };
}

async function erosHarness(): Promise<Harness> {
  const rig = makeErosRig();
  await activateErosPod(rig);
  return {
    name: 'Eros',
    key: 'omnipod-eros/pod',
    driver: rig.driver,
    secrets: rig.secrets,
    logs: rig.logs,
    allLogs: rig.allLogs,
    clock: rig.clock,
    advance: rig.advance,
    newDriver: rig.newDriver,
    delivered: () => rig.bench.deliveredBolusUnits,
    tempRunning: () => (rig.bench.model as unknown as { temp: unknown }).temp !== null,
  };
}

/** Rewrites the stored record. */
async function editRecord(h: Harness, fn: (r: Record<string, any>) => void): Promise<void> {
  const raw = JSON.parse((await h.secrets.get(h.key))!);
  fn(raw);
  await h.secrets.set(h.key, JSON.stringify(raw));
}

/** A pending command the pod's status can never settle: same message number as its predecessor, no delivery trace. */
async function seedAmbiguousPending(h: Harness, pending: Record<string, unknown>): Promise<void> {
  await editRecord(h, (r) => {
    const seq = r.lastStatus.lastProgrammingMessageSeqNum;
    r.ledger.pending = { messageNumber: seq, priorProgSeq: seq, sentAt: h.clock.t, ...pending };
  });
}

const bolusUnits = (hist: readonly InsulinDose[]): number => hist.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + d.units : s), 0);

describe.each([
  ['DASH', dashHarness],
  ['Eros', erosHarness],
])('Omnipod %s: review findings', (_name, make) => {
  it('suspend over an unresolved pending bolus counts the full amount as delivered (IOB over-, not under-estimated)', async () => {
    const h = await make();
    await seedAmbiguousPending(h, { kind: 'bolus', units: 1.5, automatic: false, id: 'pending-bolus-1' });
    const driver = h.newDriver();
    expect(await driver.history(0)).toEqual([]); // unconfirmed: not in history yet
    const r = await driver.suspend();
    expect(r.ok).toBe(true); // stopping insulin stays possible
    expect(bolusUnits(await driver.history(0))).toBeCloseTo(1.5, 5);
    expect(h.logs.some((l) => /^warn .*unresolved/i.test(l))).toBe(true);
    expect(h.delivered()).toBe(0); // the pod never ran it; the record errs on the safe side
    // not counted twice after more syncs
    await h.advance(60_000);
    await driver.status();
    expect(bolusUnits(await driver.history(0))).toBeCloseTo(1.5, 5);
  });

  it('cancel-bolus over an unresolved pending bolus sends the cancel to the pod instead of assuming nothing runs', async () => {
    const h = await make();
    await seedAmbiguousPending(h, { kind: 'bolus', units: 1.5, automatic: false, id: 'pending-bolus-2' });
    const driver = h.newDriver();
    const r = await driver.cancelBolus();
    expect(r.ok).toBe(true);
    expect(h.logs.some((l) => /replacing the unresolved 1\.50 U bolus/i.test(l))).toBe(true); // the cancel was programmed on the pod
    expect(bolusUnits(await driver.history(0))).toBeCloseTo(1.5, 5); // still counted on the safe side
  });

  it('suspend over an unresolved pending temp basal records it as running from its send time', async () => {
    const h = await make();
    await seedAmbiguousPending(h, { kind: 'tempBasal', rate: 2, durationMin: 60 });
    const driver = h.newDriver();
    await h.advance(10 * 60_000);
    expect((await driver.suspend()).ok).toBe(true);
    const temps = (await driver.history(0)).filter((d) => d.kind === 'tempBasal');
    expect(temps).toHaveLength(1);
    expect(temps[0]).toMatchObject({ kind: 'tempBasal', rate: 2 });
    expect((temps[0] as { durationMin: number }).durationMin).toBeGreaterThan(8);
    expect((temps[0] as { durationMin: number }).durationMin).toBeLessThanOrEqual(11);
  });

  it('does not send when the pending record cannot be written (ok:false, nothing delivered)', async () => {
    const h = await make();
    await h.driver.connect();
    const real = h.secrets.set.bind(h.secrets);
    (h.secrets as { set: SecretStore['set'] }).set = (k, v) => (typeof v === 'string' && v.includes('"pending":{') ? Promise.reject(new Error('disk full')) : real(k, v));
    const r: CommandResult = await h.driver.bolus(1, { automatic: false });
    expect(r.ok).toBe(false);
    await h.advance(30_000);
    expect(h.delivered()).toBe(0);
    expect(bolusUnits(await h.driver.history(0))).toBe(0);
    (h.secrets as { set: SecretStore['set'] }).set = real;
    expect((await h.driver.status()).bolusing).toBe(false);
    expect((await h.driver.bolus(0.5, { automatic: false })).ok).toBe(true); // recovers once the store works
  });

  it('cancelTempBasal reaches the pod when only the pod status shows a temp basal', async () => {
    const h = await make();
    expect((await h.driver.setTempBasal(1, 30)).ok).toBe(true);
    expect(h.tempRunning()).toBe(true);
    await editRecord(h, (r) => {
      r.ledger.basal = { kind: 'scheduled' }; // the ledger lost track of it; lastStatus still says tempBasalRunning
    });
    const driver = h.newDriver();
    expect((await driver.cancelTempBasal()).ok).toBe(true);
    expect(h.tempRunning()).toBe(false);
  });

  it.each([
    [45, 30],
    [10, 30],
    [29, 30],
    [59, 30],
    [60, 60],
    [89, 60],
    [90, 90],
  ])('temp basal of %i min is programmed as %i min and recorded so', async (asked, programmed) => {
    const h = await make();
    const r = await h.driver.setTempBasal(1, asked);
    expect(r.ok).toBe(true);
    expect(r.ok && r.dose).toMatchObject({ kind: 'tempBasal', durationMin: programmed });
    const state = await h.driver.status();
    expect(state.tempBasal?.durationMin).toBe(programmed);
    const temps = (await h.driver.history(0)).filter((d) => d.kind === 'tempBasal');
    expect(temps).toHaveLength(1);
    expect(temps[0]).toMatchObject({ durationMin: programmed });
  });
});
