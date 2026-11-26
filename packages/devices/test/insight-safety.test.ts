import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, type SecretStore } from '@buddy/core';
import { credentialsKey, encodeCredentials } from '../src/insight/credentials';
import { BRIDGE_ID, bolusTotal, CLIENT_ID, flush, LTK, ltkHex, rig, settle, stateKey, up } from './insight-helpers';
import { base64Encode } from '../src/insight/bytes';

const sentBoluses = (r: ReturnType<typeof rig>) => r.sim.executed.filter((e) => e.op === 'deliverBolus').length;

describe('Insight dosing: ok only when the pump confirmed', () => {
  it('a rejected bolus is ok:false, leaves no record and no history, and the next bolus works', async () => {
    const r = rig();
    await up(r);
    r.sim.failNextDosing({ code: 'pumpBusy', message: 'busy' });
    const res = await r.driver.bolus(1, { automatic: false });
    expect(res.ok).toBe(false);
    expect(r.driver.pendingCommand()).toBeNull();
    expect(bolusTotal(await r.driver.history(0))).toBe(0);
    expect(sentBoluses(r)).toBe(0);
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(0.5, 6);
  });

  it('rounds a bolus down to the pump grid and refuses amounts above the limits or the reservoir', async () => {
    const r = rig({ settings: { maxBolus: 2 }, sim: { reservoir: 1.0 } });
    await up(r);
    expect((await r.driver.bolus(0.03, { automatic: false })).ok).toBe(false); // rounds to 0
    expect((await r.driver.bolus(2.5, { automatic: false })).ok).toBe(false); // above max
    expect((await r.driver.bolus(1.5, { automatic: false })).ok).toBe(false); // above reservoir
    expect(sentBoluses(r)).toBe(0);
    expect((await r.driver.bolus(0.57, { automatic: false })).ok).toBe(true);
    expect(r.sim.executed.find((e) => e.op === 'deliverBolus')?.args.amount).toBe(0.55);
  });

  it('refuses to dose when the pump is suspended, unreachable or its data is stale', async () => {
    const r = rig();
    await up(r);
    expect((await r.driver.suspend()).ok).toBe(true);
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(false);
    expect((await r.driver.setTempBasal(1.5, 30)).ok).toBe(false);
    expect((await r.driver.resume()).ok).toBe(true);
    r.sim.pumpLink = 'disconnected';
    const res = await r.driver.bolus(0.5, { automatic: false });
    expect(res.ok).toBe(false);
    expect(sentBoluses(r)).toBe(0);
  });

  it('refuses a second bolus while one is running and reports bolusing', async () => {
    const r = rig();
    await up(r);
    expect((await r.driver.bolus(1, { automatic: false })).ok).toBe(true);
    expect((await r.driver.status()).bolusing).toBe(true);
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(false);
    expect(sentBoluses(r)).toBe(1);
  });

  it('cancelling a bolus records only what was delivered', async () => {
    const r = rig();
    await up(r);
    await r.driver.bolus(2, { automatic: false });
    await r.advance(30_000); // 0.75 U at 40 s/U
    const c = await r.driver.cancelBolus();
    expect(c.ok).toBe(true);
    await r.advance(60_000);
    await settle(r);
    const total = bolusTotal(await r.driver.history(0));
    expect(total).toBeGreaterThan(0.5);
    expect(total).toBeLessThan(1);
    expect(total).toBeCloseTo(r.sim.deliveredBolusUnits(), 3);
  });

  it('records boluses programmed on the pump itself exactly once', async () => {
    const r = rig();
    await up(r);
    r.sim.programBolusOnPump(1);
    await flush();
    expect((await r.driver.status()).bolusing).toBe(true);
    await r.advance(60_000);
    await settle(r);
    for (let i = 0; i < 3; i++) await r.driver.history(0);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(1, 6);
  });
});

describe('Insight dosing: unknown outcomes', () => {
  it('persists the pending record before the command is sent', async () => {
    const events: string[] = [];
    const inner = createMemorySecretStore({ [credentialsKey(BRIDGE_ID)]: encodeCredentials({ bridgeId: BRIDGE_ID, ltk: LTK, clientId: CLIENT_ID }) });
    const secrets: SecretStore = {
      get: (k) => inner.get(k),
      set: async (k, v) => {
        if (k === stateKey(BRIDGE_ID) && v && JSON.parse(v).pending) events.push('persist-pending');
        await inner.set(k, v);
      },
    };
    const r = rig({ secrets });
    await up(r);
    const push = r.sim.executed.push.bind(r.sim.executed);
    r.sim.executed.push = (...items) => {
      for (const i of items) events.push(`sim:${i.op}`);
      return push(...items);
    };
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    expect(events.indexOf('persist-pending')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('persist-pending')).toBeLessThan(events.indexOf('sim:deliverBolus'));
  });

  it('does not send anything when the pending record cannot be stored', async () => {
    const inner = createMemorySecretStore({ [credentialsKey(BRIDGE_ID)]: encodeCredentials({ bridgeId: BRIDGE_ID, ltk: LTK, clientId: CLIENT_ID }) });
    let failing = false;
    const secrets: SecretStore = {
      get: (k) => inner.get(k),
      set: async (k, v) => {
        if (failing && k === stateKey(BRIDGE_ID)) throw new Error('keychain locked');
        await inner.set(k, v);
      },
    };
    const r = rig({ secrets });
    await up(r);
    failing = true;
    const res = await r.driver.bolus(0.5, { automatic: false });
    expect(res.ok).toBe(false);
    expect(sentBoluses(r)).toBe(0);
    expect(r.sim.deliveredBolusUnits()).toBe(0);
    failing = false;
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
  });

  it('a lost answer is never ok:true, blocks dosing, and resolves through getRequestOutcome without a resend', async () => {
    const r = rig();
    await up(r);
    r.sim.loseNextResponses(1);
    const res = await r.driver.bolus(1, { automatic: false });
    expect(res.ok).toBe(false);
    expect(r.driver.pendingCommand()?.kind).toBe('bolus');
    expect(bolusTotal(await r.driver.history(0))).toBeLessThanOrEqual(r.sim.deliveredBolusUnits() + 1e-9);
    // The next attempt resolves the old command first (the bridge says it succeeded), then sees the bolus running.
    const second = await r.driver.bolus(0.5, { automatic: false });
    expect(second.ok).toBe(false);
    expect(r.driver.pendingCommand()).toBeNull();
    expect(sentBoluses(r)).toBe(1); // never re-sent
    await r.advance(60_000);
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(1, 6);
    expect(sentBoluses(r)).toBe(1);
  });

  it('an uncertain command that did not run stays blocking until a settled status proves it, then dosing is allowed again', async () => {
    const r = rig();
    await up(r);
    r.sim.failNextDosing({ code: 'internal', message: 'link to the pump lost', uncertain: true }, false);
    expect((await r.driver.bolus(1, { automatic: false })).ok).toBe(false);
    expect(r.driver.pendingCommand()).not.toBeNull();
    // Nothing proves absence yet (the status is not older than a minute after the command): still blocked.
    const blocked = await r.driver.bolus(0.5, { automatic: false });
    expect(blocked.ok).toBe(false);
    expect(sentBoluses(r)).toBe(0);
    expect(bolusTotal(await r.driver.history(0))).toBe(0);
    await r.advance(5 * 60_000);
    expect(await r.driver.resolveUncertain()).toBe('notDelivered');
    expect(r.driver.pendingCommand()).toBeNull();
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(0.5, 6);
  });

  it('an older bridge that cannot answer getRequestOutcome is resolved from status and history evidence', async () => {
    const r = rig();
    await up(r);
    r.sim.setOutcomeUnknown(true);
    r.sim.loseNextResponses(1);
    expect((await r.driver.bolus(1, { automatic: false })).ok).toBe(false);
    await r.advance(90_000);
    expect(await r.driver.resolveUncertain()).toBe('delivered');
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(1, 6);
    expect(sentBoluses(r)).toBe(1);
  });

  it('an unreadable answer to a dosing command is an unknown outcome, not a failure or a success', async () => {
    const r = rig();
    await up(r);
    r.sim.corruptNextDosingAnswer();
    const res = await r.driver.bolus(0.5, { automatic: false });
    expect(res.ok).toBe(false);
    expect(r.driver.pendingCommand()).not.toBeNull();
    expect(await r.driver.resolveUncertain()).toBe('delivered');
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(0.5, 6);
  });

  it('the unresolved record survives an app restart and blocks insulin there too', async () => {
    const r = rig();
    await up(r);
    r.sim.failNextDosing({ code: 'internal', message: 'lost', uncertain: true }, false);
    expect((await r.driver.bolus(1, { automatic: false })).ok).toBe(false);
    const second = r.restart();
    await second.status(); // loads the stored state; nothing proves absence yet
    expect(second.pendingCommand()?.kind).toBe('bolus');
    expect((await second.bolus(0.5, { automatic: false })).ok).toBe(false);
    expect((await second.setTempBasal(1.5, 30)).ok).toBe(false);
    expect(sentBoluses(r)).toBe(0);
    await r.advance(5 * 60_000);
    expect(await second.resolveUncertain()).toBe('notDelivered');
    expect((await second.bolus(0.5, { automatic: false })).ok).toBe(true);
  });

  it('a link that drops after the pump accepted the bolus is reconciled after reconnecting and never over-reports', async () => {
    const r = rig();
    await up(r);
    r.dropConnectionAfterNextCommand();
    const res = await r.driver.bolus(1, { automatic: false });
    expect(res.ok).toBe(false);
    await r.advance(5_000);
    await up(r);
    await r.advance(60_000);
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(r.sim.deliveredBolusUnits(), 6);
    expect(sentBoluses(r)).toBe(1);
  });

  it('reduce-only commands are not blocked by an unresolved command, additions are', async () => {
    const r = rig();
    await up(r);
    expect((await r.driver.syncBasalProfile()).ok).toBe(true);
    r.sim.failNextDosing({ code: 'internal', message: 'lost', uncertain: true }, false);
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(false);
    expect(r.driver.pendingCommand()).not.toBeNull();
    expect((await r.driver.setTempBasal(1.5, 30)).ok).toBe(false); // adds insulin
    expect((await r.driver.setTempBasal(0.5, 30)).ok).toBe(true); // reduces
    expect((await r.driver.cancelTempBasal()).ok).toBe(true);
    expect((await r.driver.suspend()).ok).toBe(true);
    expect((await r.driver.resume()).ok).toBe(false); // adds insulin
  });

  it('the user can resolve an unknown command by hand', async () => {
    const r = rig();
    await up(r);
    r.sim.setOutcomeUnknown(true);
    r.sim.failNextDosing({ code: 'internal', message: 'lost', uncertain: true }, false);
    await r.driver.bolus(1, { automatic: false });
    expect(r.driver.pendingCommand()).not.toBeNull();
    await r.driver.forceResolve(false);
    expect(r.driver.pendingCommand()).toBeNull();
    expect(bolusTotal(await r.driver.history(0))).toBe(0);
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
  });
});

describe('Insight secrets and logging', () => {
  it('never logs keys, pairing material or raw frames', async () => {
    const r = rig();
    await up(r);
    r.sim.loseNextResponses(1);
    await r.driver.bolus(1, { automatic: false });
    await r.driver.setTempBasal(1.5, 30);
    r.sim.failNextDosing({ code: 'internal', uncertain: true }, true);
    await r.driver.suspend();
    await r.advance(60_000);
    await r.driver.resolveUncertain();
    const all = r.log.lines.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [ltkHex, CLIENT_ID, base64Encode(LTK), 'ltk', 'pairingSecret', '"op"', 'envelope']) expect(all).not.toContain(secret);
    expect(JSON.stringify(r.driver.info())).not.toContain(ltkHex);
  });

  it('keeps pairing keys out of the pump state blob', async () => {
    const r = rig();
    await up(r);
    await r.driver.bolus(0.5, { automatic: false });
    const blob = (await r.secrets.get(stateKey(BRIDGE_ID))) ?? '';
    expect(blob.length).toBeGreaterThan(10);
    expect(blob).not.toContain(ltkHex);
    expect(blob).not.toContain(CLIENT_ID);
  });

  it('works with the pairing key supplied as the secret setting', async () => {
    const secrets = createMemorySecretStore();
    const r = rig({ secrets, settings: { pairingSecret: encodeCredentials({ bridgeId: BRIDGE_ID, ltk: LTK, clientId: CLIENT_ID }) } });
    await up(r);
    expect((await r.driver.status()).reservoirUnits).not.toBeNull();
  });
});

describe('Insight connection', () => {
  it('connect() throws a readable error when no bridge answers, and commands fail without sending', async () => {
    const r = rig();
    r.ble.transport.connect = async () => {
      throw new Error('no such device');
    };
    await expect(r.driver.connect()).rejects.toThrow(/bridge/i);
    const res = await r.driver.bolus(0.5, { automatic: false });
    expect(res.ok).toBe(false);
    expect((await r.driver.status()).bolusing).toBe(false);
    expect(await r.driver.history(0)).toEqual([]);
    await flush();
  });

  it('finds the bridge by scanning when the remembered address went stale', async () => {
    const r = rig({ settings: { bridgePeripheral: 'old-rotated-address' } });
    await up(r);
    expect((await r.driver.status()).reservoirUnits).not.toBeNull();
    const state = JSON.parse((await r.secrets.get(stateKey(BRIDGE_ID))) ?? '{}') as { peripheralId?: string };
    expect(state.peripheralId).toBe(r.sim.id);
  });

  it('declares the pairing broken only after the bridge rejected this phone twice, 30 s apart', async () => {
    const r = rig({ sim: { paired: { ltk: LTK, clientId: 'ffffffffffffffff' } }, timeouts: { connectMs: 300 } });
    await expect(r.driver.connect()).rejects.toThrow();
    expect(r.driver.info().needsRepair).toBe(false);
    r.setNow(r.now() + 31_000);
    await expect(r.driver.connect()).rejects.toThrow(/pair/i);
    expect(r.driver.info().needsRepair).toBe(true);
    const scans = r.ble.writes.length;
    await expect(r.driver.connect()).rejects.toThrow(/pair/i);
    expect(r.ble.writes.length).toBe(scans); // no more attempts until the user pairs again
  });
});

describe('Insight link health', () => {
  it('probes a quiet session before a dosing command, so a half-open link never becomes an unknown outcome', async () => {
    const r = rig();
    await up(r);
    await r.advance(5 * 60_000); // the link has been quiet for minutes
    r.sim.loseNextResponses(1); // ... and the other side is gone: the probe is not answered
    const res = await r.driver.bolus(0.5, { automatic: false });
    expect(res.ok).toBe(true);
    expect(r.driver.pendingCommand()).toBeNull();
    expect(sentBoluses(r)).toBe(1);
    await settle(r);
    expect(bolusTotal(await r.driver.history(0))).toBeCloseTo(0.5, 6);
  });

  it('starts reconnecting from the remembered address after a restart', async () => {
    const r = rig({ settings: { bridgePeripheral: 'stale-address' } });
    await up(r); // scans, finds the bridge, remembers its address
    await r.driver.disconnect();
    const second = r.restart();
    const targets: string[] = [];
    const connect = r.ble.transport.connect.bind(r.ble.transport);
    r.ble.transport.connect = (id, o) => {
      targets.push(id);
      return connect(id, o);
    };
    await second.connect();
    expect(targets[0]).toBe(r.sim.id);
  });
  it('an unreadable bolus list in the status blocks a new bolus (a bolus may be running)', async () => {
    const r = rig();
    const sim = r.sim as unknown as { statusJson: () => Record<string, unknown> };
    const original = sim.statusJson.bind(sim);
    sim.statusJson = () => ({ ...original(), boluses: 'unreadable' });
    await up(r);
    const res = await r.driver.bolus(1, { automatic: false });
    expect(res.ok).toBe(false);
    expect(sentBoluses(r)).toBe(0);
  });

  it('a stored unresolved command that cannot be read still blocks insulin', async () => {
    const r = rig();
    await r.secrets.set(stateKey(BRIDGE_ID), JSON.stringify({ version: 1, pending: { kind: 'bolus', requestId: 'r', sentAt: 'garbled' } }));
    await up(r);
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(false);
    expect(sentBoluses(r)).toBe(0);
    await r.advance(10 * 60_000);
    expect(await r.driver.resolveUncertain()).toBe('undecided'); // only the user can settle a record that cannot be read
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(false);
    await r.driver.forceResolve(false);
    expect((await r.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
  });
});
