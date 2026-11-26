/**
 * Medtrum Nano driver (TypeScript port of loopandlearn/MedtrumKit) against the protocol
 * simulator: activation flow, the shared PUMP_CONTRACT, and failure handling.
 */
import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, silentLogger, type DeviceContext, type Logger, type Millis, type SecretStore } from '@buddy/core';
import { createFakeBle, PUMP_CONTRACT, type FakeBleControls, type PumpHarness } from '../src/testkit';
import {
  activateMedtrumPatch,
  createMedtrumNanoDriver,
  deactivateMedtrumPatch,
  isMedtrumNanoDriver,
  medtrumNanoPump,
  MEDTRUM_NANO_DEFAULTS,
  MedtrumPatchSimulator,
  PatchState,
  primeMedtrumPatch,
  readMedtrumPatchStatus,
  refreshMedtrumPatch,
  type MedtrumNanoDriver,
} from '../src/medtrum';
import { CommandType } from '../src/medtrum/enums';
import { sessionKey } from '../src/medtrum/session';
import { frameResponse } from '../src/medtrum/simulator';
import { SynchronizePacket } from '../src/medtrum/notification-packet';

const SERIAL = 'AA76F9D9'; // decodes to model MD0201 (200 U)
const START: Millis = Date.UTC(2026, 10, 25, 8, 0, 0);
const SCHEDULE = [
  { startMinute: 0, value: 0.8 },
  { startMinute: 6 * 60, value: 1.1 },
];

const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2));
};

interface Rig {
  readonly driver: MedtrumNanoDriver;
  readonly sim: MedtrumPatchSimulator;
  readonly ble: FakeBleControls;
  readonly secrets: SecretStore;
  readonly clock: { t: Millis; now(): Millis };
  readonly logs: string[];
  advance(ms: number): Promise<void>;
  newDriver(): MedtrumNanoDriver;
}

function makeRig(o: { initialState?: PatchState } = {}): Rig {
  const clock = { t: START, now: () => clock.t };
  const ble = createFakeBle();
  const sim = new MedtrumPatchSimulator({ serialNumber: SERIAL, clock, initialState: o.initialState });
  ble.add(sim);
  const secrets = createMemorySecretStore();
  const logs: string[] = [];
  const log: Logger = {
    info: () => {},
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
  };
  const ctx: DeviceContext = { clock, log, fetch: globalThis.fetch, ble: ble.transport, secrets };
  const newDriver = () =>
    createMedtrumNanoDriver({ ...MEDTRUM_NANO_DEFAULTS, serialNumber: SERIAL }, ctx, {
      writeTimeoutMs: 250,
      scanTimeoutMs: 20,
      utcOffsetSeconds: () => 3600,
    });
  const driver = newDriver();
  return {
    driver,
    sim,
    ble,
    secrets,
    clock,
    logs,
    newDriver,
    async advance(ms) {
      // step in 2 s slices so the simulator emits progress like a real patch would
      for (let left = ms; left > 0; left -= 2000) {
        clock.t += Math.min(2000, left);
        sim.tick();
        await flush(1);
      }
      await flush();
    },
  };
}

async function activate(rig: Rig): Promise<void> {
  expect(await primeMedtrumPatch(rig.driver)).toEqual({ ok: true });
  await rig.advance(30_000);
  expect(await refreshMedtrumPatch(rig.driver)).toEqual({ ok: true });
  expect((await readMedtrumPatchStatus(rig.driver)).patchState).toBe(PatchState.primed);
  expect(await activateMedtrumPatch(rig.driver, SCHEDULE)).toEqual({ ok: true });
}

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

describe('Medtrum Nano PUMP_CONTRACT (simulated patch)', () => {
  for (const check of PUMP_CONTRACT) {
    it(check.name, async () => {
      await check.run(await harness());
    });
  }
});

describe('Medtrum Nano plugin', () => {
  it('has the expected metadata and refuses to build without BLE or secure storage', () => {
    expect(medtrumNanoPump.meta).toMatchObject({
      id: 'medtrum-nano',
      name: 'Medtrum Nano',
      transport: 'ble',
      maturity: 'experimental',
    });
    const base = { clock: { now: () => 0 }, log: silentLogger, fetch: globalThis.fetch };
    expect(() => medtrumNanoPump.create(medtrumNanoPump.defaultSettings, base)).toThrow(/ble/i);
    expect(() => medtrumNanoPump.create(medtrumNanoPump.defaultSettings, { ...base, ble: createFakeBle().transport })).toThrow(/secrets/i);
    const d = medtrumNanoPump.create(medtrumNanoPump.defaultSettings, { ...base, ble: createFakeBle().transport, secrets: createMemorySecretStore() });
    expect(isMedtrumNanoDriver(d)).toBe(true);
  });

  it('answers commands with ok:false (never throws) for an invalid serial number', async () => {
    const d = medtrumNanoPump.create(
      { ...MEDTRUM_NANO_DEFAULTS, serialNumber: 'zz' },
      { clock: { now: () => 0 }, log: silentLogger, fetch: globalThis.fetch, ble: createFakeBle().transport, secrets: createMemorySecretStore() },
    );
    expect(await d.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect(await d.setTempBasal(1, 30)).toMatchObject({ ok: false });
    expect(await d.history(0)).toEqual([]);
    await expect(d.connect()).rejects.toThrow(/serial/i);
  });
});

describe('Medtrum Nano activation flow', () => {
  it('primes, activates, persists the session and reconnects with the stored token', async () => {
    const rig = makeRig();
    await activate(rig);
    const st = await readMedtrumPatchStatus(rig.driver);
    expect(st.patchState).toBe(PatchState.active);
    expect(st.sessionActive).toBe(true);
    expect(st.patchId).toBe(41);
    expect(st.model).toBe('MD0201');
    expect(rig.sim.executed).toEqual(expect.arrayContaining([CommandType.PRIME, CommandType.SET_TIME, CommandType.SET_TIME_ZONE, CommandType.ACTIVATE]));

    const stored = JSON.parse((await rig.secrets.get(sessionKey(SERIAL)))!);
    expect(stored.sessionToken).toMatch(/^[0-9a-f]{8}$/);
    expect(stored.patchSessionEnded).toBe(false);

    // a fresh driver instance (app restart) picks the session up from the secret store
    await rig.driver.disconnect();
    const again = rig.newDriver();
    await again.connect();
    expect((await again.setTempBasal(0.5, 30)).ok).toBe(true);
  });

  it('refuses to prime a patch that is not filled', async () => {
    const rig = makeRig({ initialState: PatchState.idle });
    const r = await primeMedtrumPatch(rig.driver);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/not filled/);
  });

  it('refuses bolus and temp basal before a patch is active', async () => {
    const rig = makeRig();
    expect(await rig.driver.bolus(0.5, { automatic: false })).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(1, 30)).toMatchObject({ ok: false });
    expect(rig.sim.executed).not.toContain(CommandType.SET_BOLUS);
  });

  it('deactivates: stops the patch, records the suspend and falls back to the backup token for the next patch', async () => {
    const rig = makeRig();
    await activate(rig);
    expect(await deactivateMedtrumPatch(rig.driver)).toEqual({ ok: true });
    expect(rig.sim.state).toBe(PatchState.stopped);
    const st = await readMedtrumPatchStatus(rig.driver);
    expect(st.sessionActive).toBe(false);
    expect((await rig.driver.status()).suspended).toBe(true);
    expect((await rig.driver.history(0)).some((d) => d.kind === 'suspend')).toBe(true);

    // next patch: a new token is generated at prime; the base still accepts the old one until then
    rig.sim.attachNewPatch();
    await activate(rig);
    expect((await readMedtrumPatchStatus(rig.driver)).patchId).toBe(42);
    expect((await rig.driver.status()).suspended).toBe(false);
    expect((await rig.driver.history(0)).find((d) => d.kind === 'suspend')?.durationMin).toBeGreaterThanOrEqual(0);
  });
});

describe('Medtrum Nano commands', () => {
  it('floors insulin to 0.05 U and never rounds up', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.bolus(0.29, { automatic: false })).ok).toBe(true);
    await rig.advance(60_000);
    const boluses = (await rig.driver.history(0)).filter((d) => d.kind === 'bolus');
    expect(boluses).toHaveLength(1);
    expect(boluses[0]).toMatchObject({ units: 0.25 });
    expect(rig.sim.deliveredBolusUnits).toBe(0.25);

    expect((await rig.driver.setTempBasal(1.37, 30)).ok).toBe(true);
    expect(rig.sim.currentBasal.rate).toBe(1.35);
    expect((await rig.driver.status()).tempBasal?.rate).toBe(1.35);
  });

  it('rejects out-of-range requests without talking to the pump', async () => {
    const rig = makeRig();
    await activate(rig);
    const writes = rig.ble.writes.length;
    expect(await rig.driver.bolus(0.04, { automatic: false })).toMatchObject({ ok: false });
    expect(await rig.driver.bolus(31, { automatic: false })).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(26, 30)).toMatchObject({ ok: false }); // 200 U model: max 25 U/h
    expect(await rig.driver.setTempBasal(1, 0)).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(-1, 30)).toMatchObject({ ok: false });
    expect(rig.ble.writes.length).toBe(writes);
  });

  it('records the in-progress bolus with only the delivered amount', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.bolus(1, { automatic: false })).ok).toBe(true);
    await rig.advance(10_000); // 5 steps
    const partial = (await rig.driver.history(0)).filter((d) => d.kind === 'bolus');
    expect(partial).toHaveLength(1);
    expect(partial[0]!.kind === 'bolus' && partial[0]!.units).toBeCloseTo(rig.sim.deliveredBolusUnits, 5);
    expect((await rig.driver.status()).bolusing).toBe(true);
    // temp basal is refused while bolusing (as in MedtrumKit)
    expect(await rig.driver.setTempBasal(1, 30)).toMatchObject({ ok: false });
  });

  it('cancels a bolus and records what was delivered', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.bolus(2, { automatic: false })).ok).toBe(true);
    await rig.advance(6_000);
    const r = await rig.driver.cancelBolus();
    expect(r.ok).toBe(true);
    await rig.advance(10_000);
    const sum = (await rig.driver.history(0)).reduce((s, d) => (d.kind === 'bolus' ? s + d.units : s), 0);
    expect(sum).toBeCloseTo(rig.sim.deliveredBolusUnits, 5);
    expect(sum).toBeLessThan(2);
    expect((await rig.driver.status()).bolusing).toBe(false);
  });

  it('reports a timeout as ok:false and keeps an unconfirmed bolus pending until a resync settles it', async () => {
    const rig = makeRig();
    await activate(rig);
    rig.ble.dropAfterWrites(1);
    const r = await rig.driver.bolus(0.5, { automatic: true });
    expect(r.ok).toBe(false);
    expect(await rig.driver.history(0)).toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: 'smb' })]));
    await rig.advance(60_000);
    const st = await rig.driver.status(); // reconnects and syncs because a bolus is owed
    expect(st.bolusing).toBe(false);
    const smb = (await rig.driver.history(0)).filter((d) => d.kind === 'smb');
    expect(smb).toHaveLength(1);
    expect(smb[0]).toMatchObject({ units: 0.5 });
  });

  it('turns a silent pump into ok:false (timeout), not an exception', async () => {
    const rig = makeRig();
    await activate(rig);
    // swallow the next write: the patch never answers
    const original = rig.sim.onWrite.bind(rig.sim);
    rig.sim.onWrite = () => {};
    const r = await rig.driver.setTempBasal(1, 30);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/unknown|answer/);
    rig.sim.onWrite = original;
  });

  it('a pump rejection (response code) is reported and nothing is recorded', async () => {
    const rig = makeRig();
    await activate(rig);
    rig.sim.rejectNext = { cmd: CommandType.SET_BOLUS, code: 8 };
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/code 8/);
    expect((await rig.driver.status()).bolusing).toBe(false);
    await rig.advance(60_000);
    expect(await rig.driver.history(0)).toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: 'bolus' })]));
  });

  it('serializes concurrent commands (one in flight)', async () => {
    const rig = makeRig();
    await activate(rig);
    const writesBefore = rig.ble.writes.length;
    const [a, b, c] = await Promise.all([rig.driver.setTempBasal(1, 30), rig.driver.setTempBasal(2, 30), rig.driver.cancelTempBasal()]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    // set, cancel+set, cancel — each answered before the next was written
    const cmds = rig.ble.writes.slice(writesBefore).map((w) => w.data[1]);
    expect(cmds).toEqual([CommandType.SET_TEMP_BASAL, CommandType.CANCEL_TEMP_BASAL, CommandType.SET_TEMP_BASAL, CommandType.CANCEL_TEMP_BASAL]);
    const temps = (await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal');
    expect(temps.map((t) => t.kind === 'tempBasal' && t.rate)).toEqual([1, 2]);
    expect(temps.every((t) => t.kind === 'tempBasal' && t.durationMin === 0)).toBe(true); // ended immediately
  });

  it('ends the temp basal in history when the patch reports it finished early', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.setTempBasal(2, 60)).ok).toBe(true);
    await rig.advance(10 * 60_000);
    // cancelled on the patch side: the status notification shows standard basal again
    rig.sim.cancelTempBasalOnPatch();
    await rig.advance(2000);
    const temp = (await rig.driver.history(0)).find((d) => d.kind === 'tempBasal');
    expect(temp?.kind === 'tempBasal' && temp.durationMin).toBeCloseTo(10, 0);
    expect((await rig.driver.status()).tempBasal).toBeNull();
  });
});

describe('Medtrum Nano state sync', () => {
  it('detects a base reset (patch back in setup with a new id) and ends the session', async () => {
    const rig = makeRig();
    await activate(rig);
    await rig.driver.disconnect();
    rig.sim.attachNewPatch(); // base rebooted: blank patch, new id
    rig.sim.state = PatchState.idle;
    await rig.driver.connect().catch(() => {});
    const st = await readMedtrumPatchStatus(rig.driver);
    expect(st.sessionActive).toBe(false);
    expect((await rig.driver.status()).suspended).toBe(true);
    expect(rig.logs.some((l) => l.includes('base has reset'))).toBe(true);
  });

  it('decodes its own fragmented sync responses (simulator framing matches the decoder)', () => {
    const frags = frameResponse(CommandType.SYNCHRONIZE, 7, new Uint8Array([0, 0, 32, 0x20, 0, 100, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
    expect(frags.length).toBeGreaterThan(1);
    const p = new SynchronizePacket();
    frags.forEach((f) => p.decode(f));
    expect(p.failed).toBe(false);
    expect(p.isComplete).toBe(true);
    expect(p.parseResponse().reservoir).toBe(5);
  });
});

const boluses = (h: Awaited<ReturnType<MedtrumNanoDriver['history']>>) => h.filter((d) => d.kind === 'bolus' || d.kind === 'smb');

describe('Medtrum Nano: edited doses keep their id (store upserts by id)', () => {
  it('re-reports a cancelled temp basal with the shortened duration under the same id', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.setTempBasal(2, 30)).ok).toBe(true);
    const before = (await rig.driver.history(0)).find((d) => d.kind === 'tempBasal')!;
    expect(before).toMatchObject({ durationMin: 30 });
    await rig.advance(10 * 60_000);
    expect((await rig.driver.cancelTempBasal()).ok).toBe(true);
    const after = (await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal');
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.kind === 'tempBasal' && after[0]!.durationMin).toBeCloseTo(10, 1);
  });

  it('gives a suspend its real duration after resume, under the same id', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.suspend()).ok).toBe(true);
    const open = (await rig.driver.history(0)).find((d) => d.kind === 'suspend')!;
    await rig.advance(25 * 60_000);
    expect((await rig.driver.resume()).ok).toBe(true);
    await rig.advance(30 * 60_000);
    const closed = (await rig.driver.history(0)).filter((d) => d.kind === 'suspend');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.id).toBe(open.id);
    expect(closed[0]!.kind === 'suspend' && closed[0]!.durationMin).toBeCloseTo(25, 1);
  });
});

describe('Medtrum Nano: uncertain bolus outcome', () => {
  it('records the requested amount when the outcome is unknown, then corrects it to what the patch reports', async () => {
    const rig = makeRig();
    await activate(rig);
    rig.sim.reportBolus = false; // the reconnect sync will not say anything about the bolus
    rig.ble.dropAfterWrites(1);
    expect((await rig.driver.bolus(2, { automatic: false })).ok).toBe(false);
    await rig.advance(20_000); // 0.5 U delivered, then the patch stops (occlusion)
    rig.sim.stopBolusOnPatch();
    expect(rig.sim.deliveredBolusUnits).toBe(0.5);
    await rig.driver.connect();
    const first = boluses(await rig.driver.history(0));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ units: 2 }); // requested: over-reporting errs toward less insulin
    expect((await rig.driver.status()).bolusing).toBe(false);

    rig.sim.reportBolus = true; // a later status carries the final count
    expect((await rig.driver.refreshPatch()).ok).toBe(true);
    const corrected = boluses(await rig.driver.history(0));
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.id).toBe(first[0]!.id);
    expect(corrected[0]).toMatchObject({ units: 0.5 });
  });

  it('cancelTempBasal is never blocked by a pending bolus, and a stuck bolus is settled on a live link', async () => {
    const rig = makeRig();
    await activate(rig);
    expect((await rig.driver.setTempBasal(3, 60)).ok).toBe(true);
    rig.sim.loseNext = CommandType.SET_BOLUS; // lost before the patch: link stays up, no answer
    const r = await rig.driver.bolus(1, { automatic: true });
    expect(r.ok).toBe(false);
    expect(rig.driver.isConnected).toBe(true);
    expect((await rig.driver.status()).bolusing).toBe(true);

    expect((await rig.driver.cancelTempBasal()).ok).toBe(true);
    expect(rig.sim.currentBasal.type).toBe(1); // STANDARD

    for (let i = 0; i < 3; i++) {
      rig.sim.heartbeat();
      await rig.advance(2000);
    }
    expect((await rig.driver.status()).bolusing).toBe(false);
    // outcome never learned: recorded at the requested amount (MedtrumKit checkBolusDone)
    expect(boluses(await rig.driver.history(0))).toMatchObject([{ kind: 'smb', units: 1 }]);
    expect((await rig.driver.setTempBasal(1, 30)).ok).toBe(true);
  });

  it('settles a stuck bolus through status() once it should long be over', async () => {
    const rig = makeRig();
    await activate(rig);
    rig.sim.loseNext = CommandType.SET_BOLUS;
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(false);
    await rig.advance(3 * 60_000); // no heartbeats from the patch in the meantime
    rig.sim.reportBolus = false;
    expect((await rig.driver.status()).bolusing).toBe(true); // one idle sync is not enough
    for (let i = 0; i < 3; i++) await rig.driver.status();
    expect((await rig.driver.status()).bolusing).toBe(false);
  });
});

describe('Medtrum Nano: temp basal with a lost answer', () => {
  it('adopts a 120-min temp whose SetTempBasal answer was lost, with its real duration', async () => {
    const rig = makeRig();
    await activate(rig);
    rig.ble.dropAfterWrites(1);
    const r = await rig.driver.setTempBasal(2.5, 120);
    expect(r.ok).toBe(false);
    expect(rig.sim.currentBasal).toMatchObject({ type: 6, rate: 2.5 });
    const st = await rig.driver.status(); // owed resync: reconnects
    expect(st.tempBasal).toMatchObject({ rate: 2.5, durationMin: 120 });
    const temps = (await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal');
    expect(temps).toHaveLength(1);
    expect(temps[0]).toMatchObject({ rate: 2.5, durationMin: 120 });
  });

  it('records a temp of unknown duration open-ended and extends it while the patch reports it', async () => {
    const rig = makeRig();
    await activate(rig);
    rig.sim.startTempBasalOnPatch(1.5, 120);
    await rig.advance(2000);
    const first = (await rig.driver.history(0)).find((d) => d.kind === 'tempBasal')!;
    expect(first).toBeDefined();
    await rig.advance(40 * 60_000);
    expect((await rig.driver.refreshPatch()).ok).toBe(true);
    const mid = (await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal');
    expect(mid).toHaveLength(1);
    expect(mid[0]!.id).toBe(first.id);
    expect(mid[0]!.kind === 'tempBasal' && mid[0]!.durationMin).toBeGreaterThan(39);
    expect((await rig.driver.status()).tempBasal).not.toBeNull();
    await rig.advance(20 * 60_000);
    rig.sim.cancelTempBasalOnPatch();
    await rig.advance(2000);
    const done = (await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal');
    expect(done).toHaveLength(1);
    expect(done[0]!.kind === 'tempBasal' && done[0]!.durationMin).toBeCloseTo(60, 0);
    expect((await rig.driver.status()).tempBasal).toBeNull();
  });
});
