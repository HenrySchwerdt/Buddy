/**
 * Omnipod DASH driver (TypeScript port of OmnipodKit) against the protocol simulator: pairing,
 * pod lifecycle, the shared PUMP_CONTRACT and the plugin metadata. Bench scenario only: the
 * simulated pod holds water and is never attached to anything.
 */
import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, silentLogger, type DeviceContext } from '@buddy/core';
import { createFakeBle, PUMP_CONTRACT, type PumpHarness } from '../src/testkit';
import {
  createOmnipodDashDriver,
  deactivatePod,
  discardPod,
  insertCannula,
  isOmnipodDashDriver,
  omnipodDashPump,
  OMNIPOD_DASH_DEFAULTS,
  OmnipodDashSimulator,
  pairAndPrimePod,
  readPodStatus,
} from '../src/omnipod';
import { refreshPod } from '../src/omnipod/dash/activation';
import { activate, makeRig, SCHEDULE, START } from './omnipod-helpers';

async function harness(): Promise<PumpHarness> {
  const rig = makeRig();
  await activate(rig);
  return {
    driver: rig.driver,
    advance: (ms) => rig.advance(ms),
    dropConnectionAfterNextCommand: () => rig.ble.dropAfterWrites(1),
    deliveredBolusUnits: () => rig.sim.deliveredBolusUnits,
  };
}

describe('Omnipod DASH PUMP_CONTRACT (simulated pod)', () => {
  for (const check of PUMP_CONTRACT) {
    it(check.name, async () => {
      await check.run(await harness());
    });
  }
});

describe('Omnipod DASH plugin', () => {
  it('has the expected metadata and refuses to build without BLE or secure storage', () => {
    expect(omnipodDashPump.meta).toMatchObject({ id: 'omnipod-dash', name: 'Omnipod DASH', manufacturer: 'Insulet', transport: 'ble', maturity: 'experimental', requiresHardwareCheck: true });
    const base = { clock: { now: () => 0 }, log: silentLogger, fetch: globalThis.fetch };
    expect(() => omnipodDashPump.create(omnipodDashPump.defaultSettings, base)).toThrow(/ble/i);
    expect(() => omnipodDashPump.create(omnipodDashPump.defaultSettings, { ...base, ble: createFakeBle().transport })).toThrow(/secrets/i);
    const d = omnipodDashPump.create(omnipodDashPump.defaultSettings, { ...base, ble: createFakeBle().transport, secrets: createMemorySecretStore() });
    expect(isOmnipodDashDriver(d)).toBe(true);
  });

  it('answers commands with ok:false (never throws) while no pod is paired', async () => {
    const d = createOmnipodDashDriver(OMNIPOD_DASH_DEFAULTS, { clock: { now: () => 0 }, log: silentLogger, fetch: globalThis.fetch, ble: createFakeBle().transport, secrets: createMemorySecretStore() });
    expect(await d.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect(await d.setTempBasal(1, 30)).toMatchObject({ ok: false });
    expect(await d.suspend()).toMatchObject({ ok: false });
    expect(await d.history(0)).toEqual([]);
    await expect(d.connect()).resolves.toBeUndefined(); // nothing to connect yet: setup continues with pairing
    expect((await d.status()).suspended).toBe(true);
  });
});

describe('Omnipod DASH pod lifecycle', () => {
  it('pairs, primes, inserts the cannula and persists the pod', async () => {
    const rig = makeRig();
    await activate(rig);
    const st = await readPodStatus(rig.driver);
    expect(st).toMatchObject({ phase: 'running', setupProgress: 'completed', fault: null, firmwareVersion: '3.27.0' });
    expect(st.reservoirAbove50).toBe(true);
    const stored = JSON.parse((await rig.secrets.get('omnipod-dash/pod'))!);
    expect(stored.ltk).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.setupProgress).toBe('completed');
    // the pod's basal schedule is kept for resume
    expect(stored.basalSchedule).toEqual(SCHEDULE);
  });

  it('reconnects with a new session after a restart (EAP-AKA from the stored LTK)', async () => {
    const rig = makeRig();
    await activate(rig);
    const sessionsBefore = rig.sim.sessionsEstablished;
    const second = rig.newDriver();
    await rig.advance(40_000); // a stale status makes the new driver connect
    expect((await second.status()).suspended).toBe(false);
    expect(rig.sim.sessionsEstablished).toBeGreaterThan(sessionsBefore);
    expect((await second.bolus(0.1, { automatic: false })).ok).toBe(true);
  });

  it('resynchronises when the pod has seen a newer EAP sequence number', async () => {
    const rig = makeRig();
    await activate(rig);
    // wipe the driver's EAP counter: it will use a stale SQN and the pod asks for a resync
    const raw = JSON.parse((await rig.secrets.get('omnipod-dash/pod'))!);
    raw.transport.eapSeq = 0;
    await rig.secrets.set('omnipod-dash/pod', JSON.stringify(raw));
    const fresh = rig.newDriver();
    await fresh.connect();
    expect((await fresh.status()).suspended).toBe(false);
  });

  it('refuses to pair when more than one pod or none is nearby', async () => {
    const clock = { t: START, now: () => clock.t };
    const ble = createFakeBle();
    const secrets = createMemorySecretStore();
    const ctx: DeviceContext = { clock, log: silentLogger, fetch: globalThis.fetch, ble: ble.transport, secrets };
    const d = createOmnipodDashDriver(OMNIPOD_DASH_DEFAULTS, ctx, { scanTimeoutMs: 10, ioTimeoutMs: 100 });
    expect(await pairAndPrimePod(d)).toMatchObject({ ok: false, error: expect.stringMatching(/No pairable pod/) });
    ble.add(new OmnipodDashSimulator({ clock, id: 'a' }));
    ble.add(new OmnipodDashSimulator({ clock, id: 'b' }));
    expect(await pairAndPrimePod(d)).toMatchObject({ ok: false, error: expect.stringMatching(/More than one/) });
  });

  it('deactivates the pod, clears the keys and keeps the dose history', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    await rig.advance(30_000);
    expect(await deactivatePod(rig.driver)).toEqual({ ok: true });
    expect((await readPodStatus(rig.driver)).phase).toBe('none');
    const stored = JSON.parse((await rig.secrets.get('omnipod-dash/pod'))!);
    expect(stored.ltk).toBeNull();
    const history = await rig.driver.history(0);
    expect(history.filter((d) => d.kind === 'bolus')).toHaveLength(1);
  });

  it('discards an unreachable pod without talking to it', async () => {
    const rig = makeRig();
    await activate(rig);
    rig.sim.injectFault(0x1c);
    expect(await discardPod(rig.driver)).toEqual({ ok: true });
    expect((await readPodStatus(rig.driver)).phase).toBe('none');
  });

  it('resumes by programming the stored basal schedule again', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.suspend()).ok).toBe(true);
    expect((await rig.driver.status()).suspended).toBe(true);
    const before = rig.sim.received.length;
    expect((await rig.driver.resume()).ok).toBe(true);
    const programmed = rig.sim.received.slice(before).flatMap((m) => m.blocks).find((b) => b.type === 'basalScheduleExtra');
    expect(programmed).toBeDefined();
    expect((await rig.driver.status()).suspended).toBe(false);
    const suspends = (await rig.driver.history(0)).filter((d) => d.kind === 'suspend');
    expect(suspends).toHaveLength(1);
  });

  it('does not start the cannula insertion before a pod is paired and primed', async () => {
    const rig = makeRig();
    expect(await insertCannula(rig.driver, SCHEDULE)).toMatchObject({ ok: false, error: expect.stringMatching(/No pod is paired/) });
    expect(await pairAndPrimePod(rig.driver)).toEqual({ ok: true });
    expect((await readPodStatus(rig.driver)).phase).toBe('priming');
    // an invalid schedule is rejected before anything is sent to the pod
    await rig.advance(60_000);
    expect(await insertCannula(rig.driver, [{ startMinute: 30, value: 1 }])).toMatchObject({ ok: false, error: expect.stringMatching(/00:00/) });
    expect(rig.sim.received.some((m) => m.blocks.some((b) => b.type === 'basalScheduleExtra'))).toBe(false);
  });

  it('continues with the stored keys when the link broke between pairing and setup', async () => {
    const rig = makeRig();
    rig.sim.dropNextResponses(1); // the answer to the first encrypted command (AssignAddress) is lost
    const first = await pairAndPrimePod(rig.driver);
    expect(first.ok).toBe(false);
    const stored = JSON.parse((await rig.secrets.get('omnipod-dash/pod'))!);
    expect(stored.ltk).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.setupProgress).toBe('none');
    // the pod is paired now and no longer advertises as pairable: the retry must not scan for it
    expect(rig.sim.serviceUuids.some((u) => /fffe/i.test(u))).toBe(false);
    expect(await pairAndPrimePod(rig.driver)).toEqual({ ok: true });
    expect((await readPodStatus(rig.driver)).phase).toBe('priming');
    await rig.advance(60_000);
    expect(await insertCannula(rig.driver, SCHEDULE)).toEqual({ ok: true });
    await rig.advance(10_000);
    expect(await refreshPod(rig.driver)).toEqual({ ok: true });
    expect((await readPodStatus(rig.driver)).phase).toBe('running');
  });
});
