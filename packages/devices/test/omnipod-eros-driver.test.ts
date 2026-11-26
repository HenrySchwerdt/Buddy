/**
 * Omnipod Eros driver (TypeScript port of OmnipodKit) against the full simulated stack:
 * driver -> ErosMessageTransport -> RileyLinkDevice -> fake BLE -> RileyLinkSimulator -> pod.
 * PUMP_CONTRACT, plugin metadata and the pod lifecycle. Bench scenario only: the simulated pod
 * holds water and is never attached to anything.
 */
import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, silentLogger } from '@buddy/core';
import { createFakeBle, PUMP_CONTRACT, type PumpHarness } from '../src/testkit';
import {
  createOmnipodErosDriver,
  deactivateErosPod,
  discardErosPod,
  insertErosCannula,
  isOmnipodErosDriver,
  OMNIPOD_EROS_DEFAULTS,
  omnipodErosPump,
  pairAndPrimeErosPod,
  readErosPodStatus,
  refreshErosPod,
  scanForRileyLinks,
} from '../src/omnipod/eros-driver';
import { omnipodDashPump } from '../src/omnipod';
import { PodModel } from '../src/omnipod/common';
import { activateErosPod, makeErosRig, SCHEDULE } from './omnipod-eros-helpers';

async function harness(): Promise<PumpHarness> {
  const rig = makeErosRig();
  await activateErosPod(rig);
  return {
    driver: rig.driver,
    advance: (ms) => rig.advance(ms),
    dropConnectionAfterNextCommand: () => rig.ble.dropAfterWrites(1),
    deliveredBolusUnits: () => rig.bench.deliveredBolusUnits,
  };
}

describe('Omnipod Eros PUMP_CONTRACT (driver -> transport -> RileyLink simulator -> pod simulator)', () => {
  for (const check of PUMP_CONTRACT) {
    it(check.name, async () => {
      await check.run(await harness());
    });
  }
});

describe('Omnipod Eros plugin', () => {
  it('has the expected metadata and settings', () => {
    expect(omnipodErosPump.meta).toEqual({
      id: 'omnipod-eros',
      name: 'Omnipod (Eros) via RileyLink',
      manufacturer: 'Insulet',
      description: expect.stringMatching(/bench only.*water/i),
      transport: 'ble',
      maturity: 'experimental',
      requiresHardwareCheck: true,
    });
    expect(omnipodErosPump.settings.flatMap((s) => s.fields).find((f) => f.key === 'rileyLinkId')).toMatchObject({ kind: 'text' });
    expect(omnipodErosPump.defaultSettings.rileyLinkId).toBe('');
    expect(omnipodErosPump.meta.id).not.toBe(omnipodDashPump.meta.id);
  });

  it('refuses to build without BLE or secure storage', () => {
    const base = { clock: { now: () => 0 }, log: silentLogger, fetch: globalThis.fetch };
    expect(() => omnipodErosPump.create(omnipodErosPump.defaultSettings, base)).toThrow(/ble/i);
    expect(() => omnipodErosPump.create(omnipodErosPump.defaultSettings, { ...base, ble: createFakeBle().transport })).toThrow(/secure storage/i);
    const d = omnipodErosPump.create(omnipodErosPump.defaultSettings, { ...base, ble: createFakeBle().transport, secrets: createMemorySecretStore() });
    expect(isOmnipodErosDriver(d)).toBe(true);
  });

  it('answers commands with ok:false (never throws) while no pod is paired', async () => {
    const d = createOmnipodErosDriver(OMNIPOD_EROS_DEFAULTS, { clock: { now: () => 0 }, log: silentLogger, fetch: globalThis.fetch, ble: createFakeBle().transport, secrets: createMemorySecretStore() });
    expect(await d.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect(await d.setTempBasal(1, 30)).toMatchObject({ ok: false });
    expect(await d.suspend()).toMatchObject({ ok: false });
    expect(await d.history(0)).toEqual([]);
    await expect(d.connect()).resolves.toBeUndefined();
    expect((await d.status()).suspended).toBe(true);
  });

  it('scans for RileyLinks and reports name and signal', async () => {
    const rig = makeErosRig();
    const found = await scanForRileyLinks(rig.ble.transport, { timeoutMs: 10 });
    expect(found).toEqual([{ id: rig.bench.rileyLink.id, name: 'RileyLink', rssi: -60 }]);
  });
});

describe('Omnipod Eros pod lifecycle', () => {
  it('pairs, primes, inserts the cannula and persists the pod', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    const st = await readErosPodStatus(rig.driver);
    expect(st).toMatchObject({ phase: 'running', setupProgress: 'completed', fault: null, firmwareVersion: '3.27.0' });
    expect(st.reservoirAbove50).toBe(true);
    const stored = JSON.parse((await rig.secrets.get('omnipod-eros/pod'))!);
    expect(stored.setupProgress).toBe('completed');
    expect(stored.podId).toBe(rig.bench.address);
    expect(rig.bench.address >>> 24).toBe(0x1f);
    expect(stored.basalSchedule).toEqual(SCHEDULE);
    expect(stored.nonce.table).toHaveLength(18);
    expect(stored.ltk).toBeNull();
    // the radio was configured for Eros pods (Manchester, 433.91 MHz preamble)
    expect(rig.bench.rileyLink.softwareEncoding).toBe(1);
    expect(rig.bench.rileyLink.preamble).toBe(0x6665);
  });

  it('does not log nonces or seeds', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    expect(rig.allLogs.join('\n')).not.toMatch(/nonce|seed|table/i);
    expect(rig.allLogs.filter((l) => /^info Eros/.test(l))).toEqual([]);
  });

  it('sends the pairing messages to the pairing address, everything else to the assigned one', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    const [assign, setup, ...rest] = rig.bench.received;
    expect(assign!.address).toBe(0xffffffff);
    expect(assign!.blocks[0]).toMatchObject({ type: 'assignAddress', address: rig.bench.address });
    expect(setup!.address).toBe(0xffffffff);
    expect(setup!.blocks[0]).toMatchObject({ type: 'setupPod', address: rig.bench.address, lot: rig.bench.model.lot, tid: rig.bench.model.tid });
    expect(rest.every((m) => m.address === rig.bench.address)).toBe(true);
  });

  it('reconnects after a restart from the stored record (address, nonce and counters survive)', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    const badBefore = rig.bench.badNonceAnswers;
    const second = rig.newDriver();
    await rig.advance(40_000); // a stale status makes the new driver connect
    expect((await second.status()).suspended).toBe(false);
    expect((await second.bolus(0.1, { automatic: false })).ok).toBe(true);
    expect(rig.bench.badNonceAnswers).toBe(badBefore); // no new resync needed
  });

  it('fails clearly when no RileyLink is selected or none is in range', async () => {
    const rig = makeErosRig();
    const none = createOmnipodErosDriver({ ...OMNIPOD_EROS_DEFAULTS, rileyLinkId: '' }, { clock: rig.clock, log: silentLogger, fetch: globalThis.fetch, ble: rig.ble.transport, secrets: createMemorySecretStore() });
    expect(await pairAndPrimeErosPod(none)).toMatchObject({ ok: false, error: expect.stringMatching(/No RileyLink selected/) });
    rig.range.unreachable = true;
    expect(await pairAndPrimeErosPod(rig.driver)).toMatchObject({ ok: false, error: expect.stringMatching(/RileyLink/) });
    expect((await readErosPodStatus(rig.driver)).phase).toBe('none');
  });

  it('treats a pod that only acknowledged SetupPod as paired and carries on', async () => {
    const rig = makeErosRig();
    const original = rig.bench.model.handle.bind(rig.bench.model);
    let acked = 0;
    rig.bench.model.handle = (req) => {
      // SetupPod (and its single retry) is executed but only acknowledged
      if (req.blocks[0]?.type === 'setupPod' && acked < 2) {
        acked += 1;
        rig.bench.ackOnlyNext(1);
      }
      return original(req);
    };
    expect(await pairAndPrimeErosPod(rig.driver)).toEqual({ ok: true });
    expect(acked).toBe(2);
    expect((await readErosPodStatus(rig.driver)).phase).toBe('priming');
    expect(rig.bench.model.progress).toBeGreaterThanOrEqual(4);
  });

  it('refuses a pod that reports other delivery parameters', async () => {
    const rig = makeErosRig();
    const original = rig.bench.model.handle.bind(rig.bench.model);
    rig.bench.model.handle = (req) => {
      const r = original(req);
      return { ...r, blocks: r.blocks.map((b) => (b.type === 'versionResponse' && b.setup ? { ...b, setup: { ...b.setup, pulseSize: 0.1 } } : b)) };
    };
    expect(await pairAndPrimeErosPod(rig.driver)).toMatchObject({ ok: false, error: expect.stringMatching(/pulse size/) });
    expect((await rig.driver.status()).suspended).toBe(true);
    expect(await pairAndPrimeErosPod(rig.driver)).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be used/) });
  });

  it('deactivates the pod, clears the record and keeps the dose history', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    await rig.advance(30_000);
    expect(await deactivateErosPod(rig.driver)).toEqual({ ok: true });
    expect((await readErosPodStatus(rig.driver)).phase).toBe('none');
    expect(rig.bench.model.deactivated).toBe(true);
    const stored = JSON.parse((await rig.secrets.get('omnipod-eros/pod'))!);
    expect(stored.podId).toBe(0);
    expect(stored.nonce).toBeNull();
    expect((await rig.driver.history(0)).filter((d) => d.kind === 'bolus')).toHaveLength(1);
  });

  it('discards an unreachable pod without talking to it', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.range.unreachable = true;
    const before = rig.bench.received.length;
    expect(await discardErosPod(rig.driver)).toEqual({ ok: true });
    expect((await readErosPodStatus(rig.driver)).phase).toBe('none');
    expect(rig.bench.received.length).toBe(before);
  });

  it('resumes by programming the stored basal schedule again', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    expect((await rig.driver.suspend()).ok).toBe(true);
    expect((await rig.driver.status()).suspended).toBe(true);
    const before = rig.bench.received.length;
    expect((await rig.driver.resume()).ok).toBe(true);
    expect((await rig.driver.status()).suspended).toBe(false);
    expect(rig.bench.received.slice(before).some((m) => m.blocks[0]?.type === 'setInsulinSchedule')).toBe(true);
  });

  it('only exposes setup progress through the pod status while pairing is half done', async () => {
    const rig = makeErosRig();
    expect((await readErosPodStatus(rig.driver)).phase).toBe('none');
    expect(await refreshErosPod(rig.driver)).toMatchObject({ ok: false });
    expect(await insertErosCannula(rig.driver, SCHEDULE)).toMatchObject({ ok: false });
    expect(PodModel.eros).toBe(2);
  });
});
