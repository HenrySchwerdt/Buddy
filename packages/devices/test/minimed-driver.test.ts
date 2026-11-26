/**
 * MiniMed driver (TypeScript port of MinimedKit) against the full simulated stack:
 * driver -> MinimedSession -> RileyLinkDevice -> fake BLE -> RileyLinkSimulator -> pump simulator.
 * PUMP_CONTRACT, plugin metadata, setup and the happy paths of every command. Bench scenario only.
 */
import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, silentLogger } from '@buddy/core';
import { createFakeBle, PUMP_CONTRACT, type PumpHarness } from '../src/testkit';
import { createMinimedDriver, isMinimedDriver, MINIMED_DEFAULTS, minimedPump, readMinimedStatus, refreshMinimed, tuneMinimedRadio } from '../src/minimed';
import { scanForRileyLinks } from '../src/omnipod';
import { omnipodErosPump } from '../src/omnipod';
import { MessageType } from '../src/minimed/messages/message-type';
import { bolusUnits, makeMinimedRig, SERIAL, START } from './minimed-helpers';

function harness(model: '723' | '522' = '723'): PumpHarness {
  const rig = makeMinimedRig({ model });
  return {
    driver: rig.driver,
    advance: (ms) => rig.advance(ms),
    dropConnectionAfterNextCommand: () => rig.ble.dropAfterWrites(1),
    deliveredBolusUnits: () => rig.bench.deliveredBolusUnits,
  };
}

describe('MiniMed PUMP_CONTRACT (driver -> session -> RileyLink simulator -> pump simulator)', () => {
  for (const model of ['723', '522'] as const) {
    describe(`pump model ${model}`, () => {
      for (const check of PUMP_CONTRACT) {
        it(check.name, async () => {
          await check.run(harness(model));
        });
      }
    });
  }
});

describe('MiniMed plugin', () => {
  it('has the expected metadata and settings', () => {
    expect(minimedPump.meta).toEqual({
      id: 'minimed',
      name: 'Medtronic MiniMed',
      manufacturer: 'Medtronic',
      description: expect.stringMatching(/MinimedKit/),
      transport: 'ble',
      maturity: 'experimental',
    });
    const fields = minimedPump.settings.flatMap((s) => s.fields);
    expect(fields.map((f) => f.key)).toEqual(['rileyLinkId', 'pumpSerial', 'pumpRegion', 'pumpModel']);
    expect(fields.find((f) => f.key === 'rileyLinkId')).toMatchObject({ kind: 'text' });
    expect(fields.find((f) => f.key === 'pumpRegion')).toMatchObject({ kind: 'select', options: [{ value: 'NA' }, { value: 'WW' }] });
    expect(fields.find((f) => f.key === 'pumpModel')).toMatchObject({ kind: 'select' });
    expect(minimedPump.defaultSettings).toEqual({ rileyLinkId: '', pumpSerial: '', pumpRegion: 'NA', pumpModel: '723' });
    expect(minimedPump.meta.id).not.toBe(omnipodErosPump.meta.id);
  });

  it('refuses to build without BLE or secure storage', () => {
    const base = { clock: { now: () => 0 }, log: silentLogger, fetch: globalThis.fetch };
    expect(() => minimedPump.create(minimedPump.defaultSettings, base)).toThrow(/ble/i);
    expect(() => minimedPump.create(minimedPump.defaultSettings, { ...base, ble: createFakeBle().transport })).toThrow(/secure storage/i);
    const d = minimedPump.create(minimedPump.defaultSettings, { ...base, ble: createFakeBle().transport, secrets: createMemorySecretStore() });
    expect(isMinimedDriver(d)).toBe(true);
  });

  it('answers commands with ok:false (never throws) while the setup is incomplete', async () => {
    const d = createMinimedDriver(MINIMED_DEFAULTS, { clock: { now: () => 0 }, log: silentLogger, fetch: globalThis.fetch, ble: createFakeBle().transport, secrets: createMemorySecretStore() });
    expect(await d.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/serial/i) });
    expect(await d.setTempBasal(1, 30)).toMatchObject({ ok: false });
    expect(await d.cancelTempBasal()).toMatchObject({ ok: false });
    expect(await d.suspend()).toMatchObject({ ok: false });
    expect(await d.resume()).toMatchObject({ ok: false });
    expect(await d.history(0)).toEqual([]);
    await expect(d.connect()).resolves.toBeUndefined();
    expect((await d.status()).suspended).toBe(true);
    expect(await readMinimedStatus(d)).toMatchObject({ configured: false, problem: expect.stringMatching(/serial/i) });
  });

  it('asks for a RileyLink and a valid region before it talks', async () => {
    const rig = makeMinimedRig({ settings: { rileyLinkId: '' } });
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/RileyLink/) });
    const badRegion = makeMinimedRig({ settings: { pumpRegion: 'EU' } });
    expect(await badRegion.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/region/i) });
    const badSerial = makeMinimedRig({ settings: { pumpSerial: '12345' } });
    expect(await badSerial.driver.suspend()).toMatchObject({ ok: false, error: expect.stringMatching(/6 digits/) });
  });

  it('scans for RileyLinks and reports name and signal', async () => {
    const rig = makeMinimedRig();
    expect(await scanForRileyLinks(rig.ble.transport, { timeoutMs: 10 })).toEqual([{ id: rig.bench.rileyLink.id, name: 'RileyLink', rssi: -60 }]);
  });
});

describe('MiniMed setup and radio', () => {
  it('reads model, reservoir, battery and limits from the pump when it connects', async () => {
    const rig = makeMinimedRig({ initialReservoirUnits: 123.4, batteryVolts: 1.3, maxBolus: 8, maxBasal: 4 });
    await rig.driver.connect();
    const st = await readMinimedStatus(rig.driver);
    expect(st).toMatchObject({ configured: true, model: '723', reservoirUnits: 123.4, suspended: false, bolusing: false, maxBolus: 8, maxBasal: 4, pendingCommand: null });
    expect(st.batteryPercent).toBe(41);
    const state = await rig.driver.status();
    expect(state).toMatchObject({ reservoirUnits: 123.4, batteryPercent: 41, bolusIncrement: 0.025, basalIncrement: 0.025 });
    expect(state.lastSync).toBe(START);
  });

  it('uses the model the pump reports, not the configured one', async () => {
    const rig = makeMinimedRig({ model: '522', settings: { pumpModel: '723' } });
    await rig.driver.connect();
    expect((await readMinimedStatus(rig.driver)).model).toBe('522');
    expect((await rig.driver.status()).bolusIncrement).toBe(0.1);
    expect(rig.warnings.join('\n')).toMatch(/reports model 522/);
    // a 522 takes 0.1 U steps: 0.19 U becomes 0.1 U
    expect((await rig.driver.bolus(0.19, { automatic: false })).ok).toBe(true);
    expect(rig.bench.pump.received.at(-1)!.messageType).toBe(MessageType.bolus);
  });

  it('configures the RileyLink radio for the region, without software encoding', async () => {
    const na = makeMinimedRig();
    await na.driver.connect();
    const sim = na.bench.rileyLink;
    expect(sim.softwareEncoding).toBe(0);
    expect(sim.registers.get(0x0c)).toBe(0x99); // narrow filter | 16 kbps
    expect(sim.registers.get(0x0f)).toBe(0x61);
    expect(sim.registers.get(0x10)).toBe(0x7e);
    expect(sim.registers.get(0x11)).toBe(0x15);
    const mhz = (s: typeof sim) => ((s.registers.get(0x0b)! + (s.registers.get(0x0a)! << 8) + (s.registers.get(0x09)! << 16)) * (24_000_000 / 65536)) / 1e6;
    expect(mhz(sim)).toBeCloseTo(916.5, 2);

    const ww = makeMinimedRig({ settings: { pumpRegion: 'WW' } });
    await ww.driver.connect();
    expect(ww.bench.rileyLink.registers.get(0x0c)).toBe(0x59); // wide filter | 16 kbps
    expect(ww.bench.rileyLink.registers.get(0x0f)).toBe(0x62);
    expect(ww.bench.rileyLink.registers.get(0x11)).toBe(0x13);
    expect(mhz(ww.bench.rileyLink)).toBeCloseTo(868.35, 2);
  });

  it('wakes a sleeping pump before talking to it', async () => {
    const rig = makeMinimedRig();
    await rig.driver.connect();
    const types = rig.bench.pump.received.map((r) => r.messageType);
    expect(types[0]).toBe(MessageType.getPumpModel); // is it awake already?
    expect(types).toContain(MessageType.powerOn);
    expect(types.indexOf(MessageType.powerOn)).toBeLessThan(types.indexOf(MessageType.readPumpStatus));
  });

  it('wakes the pump again after it went back to sleep', async () => {
    const rig = makeMinimedRig();
    await rig.driver.connect();
    await rig.advance(5 * 60_000);
    expect((await rig.driver.status()).lastSync).toBe(START + 5 * 60_000);
    expect(rig.bench.pump.received.filter((r) => r.messageType === MessageType.powerOn && !r.short)).toHaveLength(2);
  });

  it('survives a pump that fell asleep inside the awake window', async () => {
    const rig = makeMinimedRig();
    await rig.driver.connect();
    rig.bench.pump.sleep();
    await rig.advance(61_000);
    expect((await rig.driver.bolus(0.1, { automatic: false })).ok).toBe(true);
  });

  it('reports a pump that does not answer as ok:false, and never as suspended insulin', async () => {
    const rig = makeMinimedRig();
    await rig.driver.connect();
    rig.bench.pump.setSilent(true);
    await rig.advance(2 * 60_000);
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect(bolusUnits(await rig.driver.history(0))).toBe(0);
    expect(rig.bench.deliveredBolusUnits).toBe(0);
  });

  it('fails clearly when the RileyLink is out of range', async () => {
    const rig = makeMinimedRig();
    rig.range.unreachable = true;
    await expect(rig.driver.connect()).rejects.toThrow(/RileyLink/);
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/RileyLink/) });
    rig.range.unreachable = false;
    await rig.driver.connect();
    expect((await rig.driver.bolus(0.1, { automatic: false })).ok).toBe(true);
  });

  it('tunes the radio on the best channel and remembers it', async () => {
    const rig = makeMinimedRig();
    const r = await tuneMinimedRadio(rig.driver);
    expect(r).toMatchObject({ ok: true });
    expect((await readMinimedStatus(rig.driver)).frequencyMhz).toBeGreaterThan(916);
    const stored = JSON.parse((await rig.secrets.get(`minimed/pump/${SERIAL}`))!);
    expect(stored.frequencyMhz).toBe((r as { frequencyMhz: number }).frequencyMhz);
    expect(stored.lastTuned).toBe(START);
    // the next connection starts on that channel
    await rig.advance(1000);
    await rig.newDriver().connect();
    const sim = rig.bench.rileyLink;
    const mhz = ((sim.registers.get(0x0b)! + (sim.registers.get(0x0a)! << 8) + (sim.registers.get(0x09)! << 16)) * (24_000_000 / 65536)) / 1e6;
    expect(mhz).toBeCloseTo((r as { frequencyMhz: number }).frequencyMhz, 2);
  });

  it('tries to re-tune after a pump that does not answer, and gives up quietly when it still does not', async () => {
    const rig = makeMinimedRig();
    rig.bench.pump.setSilent(true);
    await rig.driver.connect(); // the pump is silent: the sync fails, the radio tune fails too
    expect(rig.warnings.join('\n')).toMatch(/radio tune failed/);
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false });
  });

  it('refreshes on demand and reports the pump as read', async () => {
    const rig = makeMinimedRig();
    expect(await refreshMinimed(rig.driver)).toEqual({ ok: true });
    expect((await readMinimedStatus(rig.driver)).lastSync).toBe(START);
    rig.bench.pump.setSilent(true);
    await rig.advance(1000);
    expect(await refreshMinimed(rig.driver)).toMatchObject({ ok: false });
  });
});
