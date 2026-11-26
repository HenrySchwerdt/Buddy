import { describe, expect, it } from 'vitest';
import { bolusTotal, flush, rig, settle, up } from './insight-helpers';

describe('Insight alerts, pump check and clock', () => {
  it('shows the active pump alert and confirms it through the bridge', async () => {
    const r = rig();
    await up(r);
    r.sim.raiseAlert(3, 'WARNING_31', 'warning');
    await r.advance(61_000);
    await r.driver.status();
    expect(r.driver.info().activeAlert).toMatchObject({ alertId: 3, alertType: 'WARNING_31', category: 'warning' });
    expect((await r.driver.confirmAlert()).ok).toBe(true);
    expect(r.sim.alert).toBeNull();
    await r.driver.status();
    expect(r.driver.info().activeAlert).toBeNull();
    expect((await r.driver.confirmAlert()).ok).toBe(false);
  });

  it('checkPump reads the pump and reports a bridge without a pump', async () => {
    const r = rig();
    await r.driver.connect();
    const status = await r.driver.checkPump();
    expect(status).toMatchObject({ serial: 'INS123456', operatingMode: 'started' });
    r.sim.pumpLink = 'notPaired';
    await expect(r.driver.checkPump()).rejects.toThrow(/no Insight pump paired/i);
  });

  it('sets the pump clock when it drifted, but only if automatic sync is on', async () => {
    const on = rig();
    on.sim.driftSeconds = 900;
    await on.driver.connect();
    expect(on.sim.executed.some((e) => e.op === 'setDateTime')).toBe(true);
    expect(on.sim.driftSeconds).toBe(0);
    const off = rig({ settings: { autoTimeSync: false } });
    off.sim.driftSeconds = 900;
    await off.driver.connect();
    expect(off.sim.executed.some((e) => e.op === 'setDateTime')).toBe(false);
    expect((await off.driver.syncTime()).ok).toBe(true);
    expect(off.sim.executed.some((e) => e.op === 'setDateTime')).toBe(true);
  });
});

describe('Insight user resolution of an unknown bolus', () => {
  it('counts a bolus the user says was given, once, and the pump history then replaces the amount', async () => {
    const r = rig();
    await up(r);
    r.sim.setOutcomeUnknown(true);
    r.sim.loseNextResponses(1);
    expect((await r.driver.bolus(1, { automatic: true })).ok).toBe(false);
    await r.driver.forceResolve(true);
    expect(r.driver.pendingCommand()).toBeNull();
    await r.advance(60_000);
    await settle(r);
    const history = await r.driver.history(0);
    expect(history.filter((d) => d.kind === 'smb' || d.kind === 'bolus')).toHaveLength(1);
    expect(bolusTotal(history)).toBeCloseTo(1, 6);
    expect(bolusTotal(history)).toBeCloseTo(r.sim.deliveredBolusUnits(), 6);
  });
});

describe('Insight queue priority', () => {
  it('a cancel that is queued behind a slow command runs before other waiting commands', async () => {
    const r = rig();
    await up(r);
    await r.driver.bolus(2, { automatic: false });
    await r.advance(10_000);
    const order: string[] = [];
    const a = r.driver.setTempBasal(0.5, 30).then(() => order.push('temp'));
    const b = r.driver.cancelBolus().then(() => order.push('cancel'));
    await Promise.all([a, b]);
    await flush();
    expect(order[0]).toBe('temp'); // the running one is never overtaken ...
    expect(r.sim.bolus).toBeNull(); // ... but the cancel did stop the bolus
  });
});
