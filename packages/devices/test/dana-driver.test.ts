import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, hex, silentLogger, totalDelivered, type DeviceContext, type InsulinDose, type SecretStore } from '@buddy/core';
import { createFakeBle, PUMP_CONTRACT, type PumpHarness } from '../src/testkit';
import { danaPump, DanaPumpSimulator, type DanaPumpDriver } from '../src/dana';
import { DanaPacketType } from '../src/dana/packet-type';
import { HistoryCode } from '../src/dana/packets/history';

const NAME = 'VJH00012FI';
const RS_KEYS = { pairingKey: new Uint8Array([237, 241, 117, 95, 135, 61]), randomPairingKey: new Uint8Array([181, 201, 65]) };
const T = DanaPacketType;

interface Rig extends PumpHarness {
  readonly driver: DanaPumpDriver;
  readonly sim: DanaPumpSimulator;
  readonly secrets: SecretStore;
  readonly clock: { now(): number };
  setNow(t: number): void;
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig(model: 'dana-i' | 'dana-rs', opts: { paired?: boolean; commandMs?: number; basal?: number; secrets?: SecretStore } = {}): Rig {
  let now = Date.UTC(2026, 10, 25, 9, 0, 0);
  const clock = { now: () => now };
  const ble = createFakeBle();
  const sim = new DanaPumpSimulator({
    deviceName: NAME,
    model,
    clock,
    basalProfile: Array.from({ length: 24 }, () => opts.basal ?? 1),
    ...(model === 'dana-rs' && opts.paired !== false ? { rsKeys: RS_KEYS } : {}),
  });
  ble.add(sim);
  const secrets =
    opts.secrets ??
    createMemorySecretStore(
      model === 'dana-rs' && opts.paired !== false
        ? { [`dana-i:${NAME}`]: JSON.stringify({ pairingKey: hex(RS_KEYS.pairingKey), randomPairingKey: hex(RS_KEYS.randomPairingKey) }) }
        : {},
    );
  const ctx: DeviceContext = { clock, log: silentLogger, fetch, ble: ble.transport, secrets };
  const driver = danaPump.create({ ...danaPump.defaultSettings, deviceName: NAME, model }, ctx) as DanaPumpDriver;
  if (opts.commandMs) (driver as unknown as { timeouts: { commandMs: number } }).timeouts.commandMs = opts.commandMs;
  return {
    driver,
    sim,
    secrets,
    clock,
    setNow: (t) => {
      now = t;
    },
    async advance(ms) {
      for (let left = ms; left > 0; ) {
        // 1 s steps while a bolus runs (progress notifications), one jump otherwise
        const step = sim.bolus ? Math.min(1000, left) : left;
        left -= step;
        now += step;
        sim.advance(step);
        await flush();
      }
    },
    dropConnectionAfterNextCommand: () => sim.dropAfterNextCommand(),
    deliveredBolusUnits: () => sim.deliveredBolusUnits(),
  };
}

const bolusTotal = (h: InsulinDose[]) => h.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + d.units : s), 0);

async function settle(r: Rig) {
  for (let i = 0; i < 120 && (await r.driver.status()).bolusing; i++) await r.advance(5_000);
}

describe.each(['dana-i', 'dana-rs'] as const)('Dana PUMP_CONTRACT (%s simulator)', (model) => {
  for (const check of PUMP_CONTRACT) {
    it(check.name, async () => {
      const r = rig(model);
      await check.run(r);
      await r.driver.disconnect();
    });
  }
});

describe('Dana contract drop check really drops mid-bolus', () => {
  it('the dropped command is the bolus start and the delivered units are recovered from history', async () => {
    const r = rig('dana-i');
    const drop = PUMP_CONTRACT.find((c) => c.name.includes('link drops'))!;
    await drop.run(r);
    expect(r.sim.commands.filter((op) => op === T.OPCODE_BOLUS__SET_STEP_BOLUS_START)).toHaveLength(1);
    expect(r.sim.deliveredBolusUnits()).toBe(1);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(1, 5);
  });
});

describe('Dana plugin', () => {
  it('has the requested meta', () => {
    expect(danaPump.meta).toMatchObject({ id: 'dana-i', name: 'Dana-i / Dana RS', transport: 'ble', maturity: 'experimental' });
  });

  it('create() needs BLE and a valid pump name', () => {
    const base = { clock: { now: () => 0 }, log: silentLogger, fetch };
    expect(() => danaPump.create({ ...danaPump.defaultSettings, deviceName: NAME }, base)).toThrow(/needs Bluetooth/);
    const ble = createFakeBle().transport;
    expect(() => danaPump.create({ ...danaPump.defaultSettings, deviceName: 'nope' }, { ...base, ble })).toThrow(/invalid pump name/);
  });
});

describe('Dana pairing and handshake', () => {
  it('Dana-i: stores the BLE5 key and the BLE identifier in secure storage', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    const stored = JSON.parse((await r.secrets.get(`dana-i:${NAME}`))!) as Record<string, unknown>;
    expect(stored.ble5Keys).toBe('363636383636');
    expect(stored.bleId).toBe(`dana-${NAME}`);
  });

  it('Dana RS: PIN pairing, keys persisted, reconnect without PINs', async () => {
    const r = rig('dana-rs', { paired: false });
    r.driver.onPincodeRequest(() => {
      const pins = r.sim.displayedPins!;
      expect(r.driver.providePincode(pins.pin1, '00000000').ok).toBe(false); // bad checksum
      expect(r.driver.providePincode(pins.pin1, pins.pin2)).toEqual({ ok: true });
    });
    await r.driver.connect();
    const stored = JSON.parse((await r.secrets.get(`dana-i:${NAME}`))!) as Record<string, string>;
    expect(stored.pairingKey).toHaveLength(12);
    expect(stored.randomPairingKey).toHaveLength(6);

    await r.driver.disconnect();
    r.driver.onPincodeRequest(() => {
      throw new Error('must not ask for PINs again');
    });
    expect((await r.driver.status()).lastSync).toBeGreaterThan(0);
    expect((await r.driver.setTempBasal(0.5, 30)).ok).toBe(true);
  });

  it('refuses a pump of the wrong model', async () => {
    const ble = createFakeBle();
    const clock = { now: () => Date.UTC(2026, 10, 25, 9) };
    ble.add(new DanaPumpSimulator({ deviceName: NAME, model: 'dana-i', clock }));
    const driver = danaPump.create({ ...danaPump.defaultSettings, deviceName: NAME, model: 'dana-rs' }, { clock, log: silentLogger, fetch, ble: ble.transport });
    await expect(driver.connect()).rejects.toThrow(/not a Dana RS/);
    expect(await driver.setTempBasal(1, 30)).toMatchObject({ ok: false });
  });

  it('fails clearly when the pump cannot be found', async () => {
    const ble = createFakeBle();
    const clock = { now: () => 0 };
    const driver = danaPump.create({ ...danaPump.defaultSettings, deviceName: NAME }, { clock, log: silentLogger, fetch, ble: ble.transport });
    await expect(driver.connect()).rejects.toThrow(/not findable/);
    expect(await driver.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect((await driver.status()).lastSync).toBe(0);
    expect(await driver.history(0)).toEqual([]);
  });
});

describe('Dana temp basals', () => {
  it('converts U/h to a floored percentage of the pump profile and reports what runs', async () => {
    const r = rig('dana-i', { basal: 0.8 });
    await r.driver.connect();
    const res = await r.driver.setTempBasal(1.5, 30);
    expect(res).toMatchObject({ ok: true, dose: { kind: 'tempBasal', rate: 1.5, durationMin: 30 } });
    expect(r.sim.temp?.percent).toBe(187); // DanaKit would send 188 (round)
    expect(r.sim.commands.at(-1)).toBe(T.OPCODE_BASAL__APS_SET_TEMPORARY_BASAL);
  });

  it('uses the hour command for long temps and 15 min above 200 %', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    expect(await r.driver.setTempBasal(1.2, 90)).toMatchObject({ ok: true, dose: { durationMin: 60 } });
    expect(r.sim.commands.at(-1)).toBe(T.OPCODE_BASAL__SET_TEMPORARY_BASAL);
    expect(await r.driver.setTempBasal(2.5, 60)).toMatchObject({ ok: true, dose: { rate: 2.5, durationMin: 15 } });
    // the running temp was cancelled first; replaced at the instant it started, it is truncated to 0 min
    const hist = await r.driver.history(0);
    expect(hist.filter((d) => d.kind === 'tempBasal').map((d) => (d.kind === 'tempBasal' ? d.durationMin : -1))).toEqual([0, 0, 15]);
    expect(await r.driver.setTempBasal(1, 10)).toMatchObject({ ok: false });
  });

  it('notices a temp basal cancelled on the pump itself', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    await r.driver.setTempBasal(2, 30);
    r.sim.temp = null;
    await r.advance(60_000);
    expect((await r.driver.status()).tempBasal).toBeNull();
    expect((await r.driver.history(0)).at(-1)).toMatchObject({ kind: 'tempBasal', durationMin: 0 });
  });

  it('confirms a temp basal whose answer was lost by reading the pump status', async () => {
    const r = rig('dana-i', { commandMs: 100 });
    await r.driver.connect();
    r.sim.swallowResponses((op) => op === T.OPCODE_BASAL__APS_SET_TEMPORARY_BASAL);
    expect(await r.driver.setTempBasal(1.5, 30)).toMatchObject({ ok: true, dose: { rate: 1.5 } });
    r.sim.swallowResponses((op) => op === T.OPCODE_BASAL__SET_SUSPEND_ON);
    expect(await r.driver.suspend()).toMatchObject({ ok: false, error: expect.stringMatching(/Timeout/) });
  });
});

describe('Dana boluses', () => {
  it('records partial deliveries after a cancel', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    expect((await r.driver.bolus(2, { automatic: false })).ok).toBe(true);
    await r.advance(6_000); // 12 s/U → 0.5 U
    const c = await r.driver.cancelBolus();
    expect(c.ok).toBe(true);
    const recorded = bolusTotal(await r.driver.history(0));
    expect(recorded).toBeCloseTo(r.sim.deliveredBolusUnits(), 5);
    expect(recorded).toBeGreaterThan(0.4);
    expect(recorded).toBeLessThan(0.6);
    expect((await r.driver.status()).bolusing).toBe(false);
  });

  it('floors to the 0.05 U grid and rejects tiny boluses', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    expect(await r.driver.bolus(0.04, { automatic: true })).toMatchObject({ ok: false });
    expect((await r.driver.bolus(0.29, { automatic: true })).ok).toBe(true);
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(0.25, 5);
  });

  it('maps pump rejections to errors', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    expect(await r.driver.bolus(15, { automatic: false })).toEqual({ ok: false, error: 'Max bolus violation' });
    expect((await r.driver.status()).bolusing).toBe(false);
  });

  it('reconciles a bolus whose start confirmation was lost on the pump history (link drop after BolusStart)', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    r.sim.dropAfterNextCommand((op) => op === T.OPCODE_BOLUS__SET_STEP_BOLUS_START);
    const res = await r.driver.bolus(1, { automatic: true });
    expect(res.ok).toBe(false);
    expect((await r.driver.history(0)).length).toBe(0); // nothing reported before reconciliation
    await r.advance(30_000);
    const hist = await r.driver.history(0); // reconnects and reads the pump history
    expect(hist).toEqual([expect.objectContaining({ kind: 'smb', units: 1 })]);
    expect(r.sim.deliveredBolusUnits()).toBe(1);
    expect((await r.driver.status()).bolusing).toBe(false);
  });

  it('keeps an uncertain bolus open while the pump is still delivering it', async () => {
    const r = rig('dana-i', { commandMs: 100 });
    await r.driver.connect();
    r.sim.swallowResponses((op) => op === T.OPCODE_BOLUS__SET_STEP_BOLUS_START);
    expect((await r.driver.bolus(2, { automatic: false })).ok).toBe(false);
    r.sim.swallowResponses(null);
    // 24 s bolus; after 5 s there is no history record yet → still "bolusing", nothing recorded
    await r.advance(5_000);
    expect((await r.driver.status()).bolusing).toBe(true);
    expect(await r.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect(await r.driver.setTempBasal(1, 30)).toMatchObject({ ok: false });
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(2, 5);
    expect(r.sim.deliveredBolusUnits()).toBe(2);
  });

  it('imports boluses programmed on the pump without double counting its own', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    await settle(r);
    await r.advance(10 * 60_000);
    // a user bolus given on the pump's own menu
    r.sim.history.push({ type: HistoryCode.RECORD_TYPE_BOLUS, at: r.clock.now() - 60_000, param8: 0x80, value: 120 });
    await r.advance(5 * 60_000);
    await r.driver.status();
    const boluses = (await r.driver.history(0)).filter((d) => d.kind === 'bolus');
    expect(boluses.map((d) => (d.kind === 'bolus' ? d.units : 0))).toEqual([0.5, 1.2]);
    await r.advance(5 * 60_000);
    await r.driver.status();
    expect((await r.driver.history(0)).filter((d) => d.kind === 'bolus')).toHaveLength(2);
  });
});

describe('Dana review regressions', () => {
  it('a lost bolus start never claims the history record of an earlier bolus', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    expect((await r.driver.bolus(0.5, { automatic: true })).ok).toBe(true);
    await settle(r);
    await r.advance(5 * 60_000);
    r.sim.loseNextCommand((op) => op === T.OPCODE_BOLUS__SET_STEP_BOLUS_START);
    expect((await r.driver.bolus(0.5, { automatic: true })).ok).toBe(false);
    await r.advance(5 * 60_000);
    await settle(r);
    expect(r.sim.deliveredBolusUnits()).toBe(0.5);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(0.5, 5);
  });

  it('a temp crossing into a higher-basal hour never exceeds the requested rate', async () => {
    const r = rig('dana-i');
    r.sim.basalProfile = Array.from({ length: 24 }, (_, h) => (h % 2 === 0 ? 0.5 : 1.5));
    r.setNow(new Date(2026, 10, 25, 10, 30).getTime()); // local 10:30, profile 0.5 → 1.5 at 11:00
    await r.driver.connect();
    const res = await r.driver.setTempBasal(1, 60);
    expect(res.ok).toBe(true);
    const pct = r.sim.temp!.percent;
    expect(pct).toBe(66);
    for (const rate of [0.5, 1.5]) expect((pct / 100) * rate).toBeLessThanOrEqual(1);
  });
  it('a hung BLE write times out as { ok: false } and does not block the queue', async () => {
    const r = rig('dana-i', { commandMs: 100 });
    await r.driver.connect();
    r.sim.stallWrites = true;
    expect(await r.driver.setTempBasal(1.5, 30)).toMatchObject({ ok: false });
    r.sim.stallWrites = false;
    await r.driver.disconnect();
    expect(await r.driver.setTempBasal(1.5, 30)).toMatchObject({ ok: true });
  });

  it('does not import its own bolus again after an app restart', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    expect((await r.driver.bolus(1, { automatic: false })).ok).toBe(true);
    await settle(r);
    await r.driver.disconnect();
    await r.advance(10 * 60_000);
    // A fresh driver instance (app restart) with the same secure storage and an older history cursor
    const stored = JSON.parse((await r.secrets.get(`dana-i:${NAME}`))!) as Record<string, unknown>;
    await r.secrets.set(`dana-i:${NAME}`, JSON.stringify({ ...stored, historyFrom: r.clock.now() - 60 * 60_000 }));
    const ble = createFakeBle();
    ble.add(r.sim);
    const again = danaPump.create({ ...danaPump.defaultSettings, deviceName: NAME }, { clock: r.clock, log: silentLogger, fetch, ble: ble.transport, secrets: r.secrets });
    await again.connect();
    await again.status();
    expect(await again.history(0)).toEqual([]);
  });
});

describe('Dana temp basal segments (percent × each hour of the pump profile)', () => {
  const temps = (h: InsulinDose[]) => h.flatMap((d) => (d.kind === 'tempBasal' && !d.id.includes('temp-end') ? [{ date: d.date, rate: d.rate, durationMin: d.durationMin, id: d.id }] : []));
  const at = (hh: number, mm: number) => new Date(2026, 10, 25, hh, mm).getTime();

  async function started() {
    const r = rig('dana-i');
    r.sim.basalProfile = Array.from({ length: 24 }, (_, h) => (h % 2 === 0 ? 0.5 : 1.5));
    r.setNow(at(10, 30));
    await r.driver.connect();
    const res = await r.driver.setTempBasal(1, 60); // 66 %
    return { r, res };
  }

  it('records one segment per profile rate with the rate the pump runs', async () => {
    const { r, res } = await started();
    expect(res).toMatchObject({ ok: true, dose: { date: at(10, 30), rate: 0.33, durationMin: 30 } });
    expect(temps(await r.driver.history(0)).map(({ id: _id, ...x }) => x)).toEqual([
      { date: at(10, 30), rate: 0.33, durationMin: 30 },
      { date: at(11, 0), rate: 0.99, durationMin: 30 },
    ]);
    r.setNow(at(11, 5));
    expect((await r.driver.status()).tempBasal).toMatchObject({ rate: 0.99, startedAt: at(10, 30), durationMin: 60 });
  });

  it('cancel in the second segment truncates it under the same id; totals match percent × schedule', async () => {
    const { r } = await started();
    const ids = temps(await r.driver.history(0)).map((t) => t.id);
    r.setNow(at(11, 10));
    expect((await r.driver.cancelTempBasal()).ok).toBe(true);
    const hist = await r.driver.history(0);
    const segs = temps(hist);
    expect(segs.map((t) => t.id)).toEqual(ids);
    expect(segs.map((t) => t.durationMin)).toEqual([30, 10]);
    const expected = 0.66 * 0.5 * 0.5 + 0.66 * 1.5 * (10 / 60);
    expect(totalDelivered(hist, at(10, 30), at(12, 0))).toBeCloseTo(expected, 6);
  });

  it('cancel before the second segment starts collapses it, so it cannot cut a later temp short', async () => {
    const { r } = await started();
    r.setNow(at(10, 40));
    expect((await r.driver.cancelTempBasal()).ok).toBe(true);
    r.setNow(at(10, 45));
    expect((await r.driver.setTempBasal(0, 30)).ok).toBe(true); // zero temp 10:45–11:15
    const hist = await r.driver.history(0);
    const first = temps(hist).filter((t) => t.date < at(10, 45));
    expect(first.map((t) => [t.date, t.durationMin])).toEqual([
      [at(10, 30), 10],
      [at(10, 40), 0],
    ]);
    // 10 min at 0.33 U/h, then nothing during the zero temp
    expect(totalDelivered(hist, at(10, 30), at(11, 15))).toBeCloseTo(0.33 * (10 / 60), 6);
  });
});

describe('Dana command serialization', () => {
  it('runs concurrent calls one at a time', async () => {
    const r = rig('dana-i');
    await r.driver.connect();
    const results = await Promise.all([r.driver.status(), r.driver.setTempBasal(1.5, 30), r.driver.history(0), r.driver.suspend(), r.driver.status()]);
    expect(results[1]).toMatchObject({ ok: true });
    expect(results[3]).toMatchObject({ ok: true });
    expect((results[4] as { suspended: boolean }).suspended).toBe(true);
  });
});
