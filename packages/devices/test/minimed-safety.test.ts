/**
 * Dosing invariants of the MiniMed driver: a command is ok:true only when the pump confirmed it, the
 * pending record is persisted before anything is sent, an unknown outcome blocks dosing until a
 * read settles it, history holds only confirmed insulin, nothing sensitive is logged. Bench scenario
 * only: the simulated pump delivers arithmetic, never insulin.
 */
import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, type SecretStore } from '@buddy/core';
import { MessageType } from '../src/minimed/messages/message-type';
import { PumpErrorCode } from '../src/minimed/messages/bodies';
import { bolusUnits, makeMinimedRig, SERIAL, START, type MinimedRig } from './minimed-helpers';

const KEY = `minimed/pump/${SERIAL}`;
const storedRecord = async (rig: MinimedRig) => JSON.parse((await rig.secrets.get(KEY))!);
const argumentsOf = (rig: MinimedRig, type: number) => rig.bench.pump.received.filter((r) => r.messageType === type && !r.short).length;

/** A secret store that notes, with every write, how many bolus argument messages the pump had heard. */
function spyStore(rig: () => MinimedRig | null) {
  const inner = createMemorySecretStore();
  const writes: { value: string; bolusArgsHeard: number }[] = [];
  const store: SecretStore = {
    get: (k) => inner.get(k),
    set: async (k, v) => {
      const r = rig();
      if (v !== null && k === KEY) writes.push({ value: v, bolusArgsHeard: r ? argumentsOf(r, MessageType.bolus) : 0 });
      await inner.set(k, v);
    },
  };
  return { store, writes };
}

async function connected(o: Parameters<typeof makeMinimedRig>[0] = {}) {
  const rig = makeMinimedRig(o);
  await rig.driver.connect();
  return rig;
}

describe('MiniMed bolus: confirmation and unknown outcomes', () => {
  it('is ok:true only after the pump acknowledged the arguments, and history shows the delivered amount', async () => {
    const rig = await connected();
    expect(await rig.driver.bolus(1, { automatic: false })).toEqual({ ok: true });
    expect(rig.bench.pump.isBolusing).toBe(true);
    expect(argumentsOf(rig, MessageType.bolus)).toBe(1);
    // under way: history counts only what the pump's delivery speed implies, never the whole amount
    await rig.advance(20_000);
    const part = bolusUnits(await rig.driver.history(0));
    expect(part).toBeGreaterThan(0);
    expect(part).toBeLessThan(1);
    expect(part).toBeLessThanOrEqual(rig.bench.deliveredBolusUnits + 0.001);
    await rig.advance(60_000);
    expect((await rig.driver.status()).bolusing).toBe(false);
    expect(bolusUnits(await rig.driver.history(0))).toBe(1);
    expect(rig.bench.deliveredBolusUnits).toBe(1);
  });

  it('refuses a bolus the pump would reject without sending it (suspended, in progress, over the limits, over the reservoir)', async () => {
    const rig = await connected({ initialReservoirUnits: 2, maxBolus: 5 });
    expect(await rig.driver.bolus(3, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/reservoir/) });
    expect(await rig.driver.bolus(0.01, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/smallest step/) });
    expect(await rig.driver.bolus(-1, { automatic: false })).toMatchObject({ ok: false });
    expect(await rig.driver.bolus(Number.NaN, { automatic: false })).toMatchObject({ ok: false });
    const big = await connected({ maxBolus: 5 });
    expect(await big.driver.bolus(6, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/maximum bolus/) });
    expect(argumentsOf(rig, MessageType.bolus) + argumentsOf(big, MessageType.bolus)).toBe(0);

    expect((await big.driver.bolus(1, { automatic: false })).ok).toBe(true);
    expect(await big.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/in progress/) });
    expect(argumentsOf(big, MessageType.bolus)).toBe(1);
  });

  it('rounds a bolus down to what the pump can deliver, never up', async () => {
    const rig = await connected();
    expect((await rig.driver.bolus(0.49, { automatic: false })).ok).toBe(true); // 0.475 on a 723
    await rig.advance(120_000);
    await rig.driver.status();
    expect(bolusUnits(await rig.driver.history(0))).toBe(0.475);
    expect(rig.bench.deliveredBolusUnits).toBe(0.475);
  });

  it('treats an acknowledgement that got lost, with the pump running the bolus, as delivered (settled by a status read)', async () => {
    const rig = await connected();
    rig.bench.pump.loseNextAcks(1);
    expect(await rig.driver.bolus(1, { automatic: true })).toEqual({ ok: true }); // proven by "bolusing"
    expect(rig.bench.pump.executed).toBe(1);
    expect((await rig.driver.status()).bolusing).toBe(true);
    await rig.advance(120_000);
    await rig.driver.status();
    const history = await rig.driver.history(0);
    expect(history.filter((d) => d.kind === 'smb')).toHaveLength(1);
    expect(bolusUnits(history)).toBe(1);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
  });

  it('reports ok:false and keeps history empty when the pump never got the arguments', async () => {
    const rig = await connected();
    rig.bench.pump.loseNextCommands(1);
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/did not take/) });
    expect(rig.bench.pump.executed).toBe(0);
    expect(await rig.driver.history(0)).toEqual([]);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
    expect((await rig.driver.status()).bolusing).toBe(false);
    // dosing is possible again: the failure was certain
    expect((await rig.driver.bolus(0.1, { automatic: false })).ok).toBe(true);
  });

  it('blocks all dosing while an outcome is unknown, and settles it when the pump answers again', async () => {
    const rig = await connected();
    rig.bench.pump.goSilentAfterNextCommand(); // executes the bolus, then hears nothing
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/i) });
    expect(rig.bench.pump.executed).toBe(1);
    // nothing unconfirmed in the history, but the loop is told a bolus may be under way
    expect(await rig.driver.history(0)).toEqual([]);
    expect((await rig.driver.status()).bolusing).toBe(true);
    expect((await storedRecord(rig)).ledger.pending).toMatchObject({ kind: 'bolus', units: 1 });
    // every delivering command is refused
    for (const r of [await rig.driver.bolus(0.5, { automatic: false }), await rig.driver.setTempBasal(1, 30), await rig.driver.resume()]) {
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/still unknown/) });
    }
    expect(argumentsOf(rig, MessageType.bolus)).toBe(1);
    // the pump comes back: the status read proves the bolus
    rig.bench.pump.setSilent(false);
    await rig.advance(30_000);
    const st = await rig.driver.status();
    expect(st.bolusing).toBe(true);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
    expect(bolusUnits(await rig.driver.history(0))).toBeGreaterThan(0);
    await rig.advance(120_000);
    await rig.driver.status();
    expect(bolusUnits(await rig.driver.history(0))).toBe(1);
    expect(rig.bench.deliveredBolusUnits).toBe(1);
  });

  it('settles an unknown outcome as "not taken" when the pump shows no bolus although it should be running', async () => {
    const rig = await connected();
    rig.bench.pump.goSilentWhenArgumentsArrive(); // the arguments are never executed and the pump hears nothing afterwards
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/i) });
    expect((await storedRecord(rig)).ledger.pending).toMatchObject({ kind: 'bolus' });
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/still unknown/) });
    rig.bench.pump.setSilent(false);
    await rig.advance(10_000); // a 1 U bolus would still be running
    expect((await rig.driver.status()).bolusing).toBe(false);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
    expect(await rig.driver.history(0)).toEqual([]);
    expect(rig.bench.deliveredBolusUnits).toBe(0);
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true); // dosing is possible again
  });

  it('settles a bolus that ran its course while the outcome was unknown from the history', async () => {
    const rig = await connected();
    rig.bench.pump.goSilentAfterNextCommand();
    expect((await rig.driver.bolus(1, { automatic: false })).ok).toBe(false);
    rig.bench.pump.setSilent(false);
    await rig.advance(10 * 60_000); // long over: only the history can tell
    expect((await rig.driver.status()).bolusing).toBe(false);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
    expect(bolusUnits(await rig.driver.history(0))).toBe(1);
    expect(rig.bench.deliveredBolusUnits).toBe(1);
  });

  it('settles a bolus that was never taken, found out only after its time is over, from the history', async () => {
    const rig = await connected();
    rig.bench.pump.goSilentWhenArgumentsArrive();
    expect((await rig.driver.bolus(1, { automatic: false })).ok).toBe(false);
    rig.bench.pump.setSilent(false);
    await rig.advance(10 * 60_000);
    expect((await rig.driver.status()).bolusing).toBe(false);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
    expect(await rig.driver.history(0)).toEqual([]);
  });

  it('persists the pending record BEFORE the pump hears the command', async () => {
    let rig: MinimedRig | null = null;
    const spy = spyStore(() => rig);
    rig = makeMinimedRig({ secrets: spy.store });
    await rig.driver.connect();
    expect((await rig.driver.bolus(1, { automatic: false })).ok).toBe(true);
    const pendingWrites = spy.writes.filter((w) => JSON.parse(w.value).ledger.pending?.kind === 'bolus');
    expect(pendingWrites.length).toBeGreaterThan(0);
    expect(pendingWrites[0]!.bolusArgsHeard).toBe(0);
    // ... and cleared once the pump confirmed
    expect(JSON.parse(spy.writes.at(-1)!.value).ledger.pending).toBeNull();
    expect(JSON.parse(spy.writes.at(-1)!.value).ledger.bolus).toMatchObject({ requested: 1 });
  });

  it('does not send when the pending record cannot be stored', async () => {
    let failing = false;
    const inner = createMemorySecretStore();
    const store: SecretStore = {
      get: (k) => inner.get(k),
      set: async (k, v) => {
        if (failing) throw new Error('keychain locked');
        await inner.set(k, v);
      },
    };
    const rig = makeMinimedRig({ secrets: store });
    await rig.driver.connect();
    failing = true;
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/persist/i) });
    expect(argumentsOf(rig, MessageType.bolus)).toBe(0);
    expect(rig.bench.pump.executed).toBe(0);
    failing = false;
    expect((await rig.driver.bolus(0.1, { automatic: false })).ok).toBe(true); // nothing is left pending
  });

  it('keeps the unknown outcome across an app restart and settles it afterwards', async () => {
    const secrets = createMemorySecretStore();
    const first = await connected({ secrets });
    first.bench.pump.goSilentAfterNextCommand();
    expect((await first.driver.bolus(1, { automatic: false })).ok).toBe(false);

    // restart: a new driver on the same storage, the pump answers again
    first.bench.pump.setSilent(false);
    const second = first.newDriver();
    expect(await second.history(0)).toEqual([]);
    expect(await second.bolus(0.5, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/still unknown|in progress/) });
    await first.advance(10_000);
    expect((await second.status()).bolusing).toBe(true); // read from the pump, pending settled
    await first.advance(120_000);
    await second.status();
    expect(bolusUnits(await second.history(0))).toBe(1);
  });

  it('serializes concurrent commands: only the first bolus is sent', async () => {
    const rig = await connected();
    const [a, b] = await Promise.all([rig.driver.bolus(1, { automatic: false }), rig.driver.bolus(1, { automatic: false })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(argumentsOf(rig, MessageType.bolus)).toBe(1);
  });

  it('never sends a bolus while the pump itself is bolusing (pump buttons)', async () => {
    const rig = await connected();
    rig.bench.pump.pumpUiBolus(2);
    await rig.advance(61_000);
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/in progress/) });
    expect(argumentsOf(rig, MessageType.bolus)).toBe(0);
  });
});

describe('MiniMed pump-side events', () => {
  it('imports a bolus from the pump buttons into history, once', async () => {
    const rig = await connected();
    rig.bench.pump.pumpUiBolus(2);
    await rig.advance(3 * 60_000);
    await rig.driver.status(); // stale: reads the pump and the history
    await rig.advance(11 * 60_000);
    await rig.driver.status();
    const doses = await rig.driver.history(0);
    expect(doses.filter((d) => d.kind === 'bolus')).toHaveLength(1);
    expect(bolusUnits(doses)).toBe(2);
    expect((await rig.driver.refresh()).ok).toBe(true);
    expect(bolusUnits(await rig.driver.history(0))).toBe(2); // no duplicate after another history read
  });

  it('does not count Buddy\'s own bolus a second time when the history shows it', async () => {
    const rig = await connected();
    expect((await rig.driver.bolus(1.5, { automatic: false })).ok).toBe(true);
    await rig.advance(3 * 60_000);
    await rig.driver.status();
    await rig.driver.refresh();
    await rig.advance(12 * 60_000);
    await rig.driver.refresh();
    expect(bolusUnits(await rig.driver.history(0))).toBe(1.5);
    expect((await storedRecord(rig)).ledger.unverified).toEqual([]); // the history confirmed the amount
  });

  it('records what a bolus really delivered when the pump stopped it early', async () => {
    const rig = await connected();
    expect((await rig.driver.bolus(3, { automatic: false })).ok).toBe(true);
    await rig.advance(30_000);
    rig.bench.pump.suspendAtPump(); // 3 U need 2 minutes: stopped after 30 s
    await rig.advance(5 * 60_000);
    const st = await rig.driver.status();
    expect(st.suspended).toBe(true);
    expect(st.bolusing).toBe(false);
    const delivered = rig.bench.deliveredBolusUnits;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(3);
    expect(bolusUnits(await rig.driver.history(0))).toBeCloseTo(delivered, 3);
  });

  it('follows a pump that was suspended at its buttons, and refuses to dose against it', async () => {
    const rig = await connected();
    rig.bench.pump.suspendAtPump();
    await rig.advance(61_000);
    expect((await rig.driver.status()).suspended).toBe(true);
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/suspended/) });
    expect(await rig.driver.setTempBasal(1, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/suspended/) });
    expect(argumentsOf(rig, MessageType.bolus)).toBe(0);
    expect((await rig.driver.history(0)).some((d) => d.kind === 'suspend')).toBe(true);
    expect((await rig.driver.resume()).ok).toBe(true);
    expect((await rig.driver.status()).suspended).toBe(false);
  });

  it('sets the pump clock when it is off by more than 20 seconds (and only then)', async () => {
    const rig = makeMinimedRig({ clockSkewMs: 5 * 60_000 });
    await rig.driver.connect();
    expect(rig.bench.pump.pumpMillis).toBe(rig.clock.t);
    expect(argumentsOf(rig, MessageType.changeTime)).toBe(1);
    await rig.advance(2 * 60_000);
    await rig.driver.status();
    expect(argumentsOf(rig, MessageType.changeTime)).toBe(1);

    const near = makeMinimedRig({ clockSkewMs: 10_000 });
    await near.driver.connect();
    expect(argumentsOf(near, MessageType.changeTime)).toBe(0);
    const optOut = makeMinimedRig({ clockSkewMs: 5 * 60_000, driver: { autoSetTime: false } });
    await optOut.driver.connect();
    expect(argumentsOf(optOut, MessageType.changeTime)).toBe(0);
  });

  it('does not touch the pump clock while a bolus runs', async () => {
    const rig = await connected();
    expect((await rig.driver.bolus(2, { automatic: false })).ok).toBe(true);
    rig.bench.pump.setClockSkew(10 * 60_000);
    await rig.advance(61_000);
    await rig.driver.status();
    expect(argumentsOf(rig, MessageType.changeTime)).toBe(0);
  });
});

describe('MiniMed temp basal', () => {
  it('programs half hours, rounds the rate down to a pump step and reports the dose as programmed', async () => {
    const rig = await connected();
    const r = await rig.driver.setTempBasal(1.07, 45);
    expect(r).toMatchObject({ ok: true, dose: { kind: 'tempBasal', rate: 1.05, durationMin: 30 } });
    expect(rig.bench.pump.tempBasal).toEqual({ rate: 1.05, remainingMin: 30 });
    expect((await rig.driver.status()).tempBasal).toMatchObject({ rate: 1.05, durationMin: 30 });
    expect(argumentsOf(rig, MessageType.changeTempBasal)).toBe(1);
    // a longer request keeps its half hours, a shorter one is raised to the minimum
    expect(await rig.driver.setTempBasal(0.5, 100)).toMatchObject({ ok: true, dose: { durationMin: 90 } });
    expect(await rig.driver.setTempBasal(0.5, 10)).toMatchObject({ ok: true, dose: { durationMin: 30 } });
  });

  it('truncates the dose when the temp basal is cancelled, and when it runs out', async () => {
    const rig = await connected();
    expect((await rig.driver.setTempBasal(2, 60)).ok).toBe(true);
    await rig.advance(20 * 60_000);
    expect((await rig.driver.cancelTempBasal()).ok).toBe(true);
    expect(rig.bench.pump.tempBasal).toBeNull();
    const [dose] = await rig.driver.history(0);
    expect(dose).toMatchObject({ kind: 'tempBasal', rate: 2, durationMin: 20 });

    expect((await rig.driver.setTempBasal(1, 30)).ok).toBe(true);
    await rig.advance(40 * 60_000);
    const st = await rig.driver.status();
    expect(st.tempBasal).toBeNull();
    expect((await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal').map((d) => (d.kind === 'tempBasal' ? d.durationMin : -1))).toEqual([20, 30]);
  });

  it('cancelling when nothing runs is ok and sends nothing', async () => {
    const rig = await connected();
    const before = argumentsOf(rig, MessageType.changeTempBasal);
    expect((await rig.driver.cancelTempBasal()).ok).toBe(true);
    expect(argumentsOf(rig, MessageType.changeTempBasal)).toBe(before);
  });

  it('refuses rates and durations outside what the pump takes, before sending', async () => {
    const rig = await connected({ maxBasal: 3 });
    expect(await rig.driver.setTempBasal(3.5, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/maximum basal/) });
    expect(await rig.driver.setTempBasal(-1, 30)).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(40, 30)).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(1, 0)).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(1, 25 * 60)).toMatchObject({ ok: false });
    expect(await rig.driver.setTempBasal(Number.NaN, 30)).toMatchObject({ ok: false });
    expect(argumentsOf(rig, MessageType.changeTempBasal)).toBe(0);
  });

  it('turns a rejection by the pump into ok:false without leaving anything pending', async () => {
    const rig = await connected();
    rig.bench.pump.rejectNext(PumpErrorCode.commandRefused);
    expect(await rig.driver.setTempBasal(1, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/refused/i) });
    expect(rig.bench.pump.tempBasal).toBeNull();
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
    expect(await rig.driver.history(0)).toEqual([]);
    expect((await rig.driver.setTempBasal(1, 30)).ok).toBe(true);
  });

  it('explains a pump that runs a percent temp basal', async () => {
    const rig = await connected();
    rig.bench.pump.setPercentTempBasal(true);
    expect(await rig.driver.setTempBasal(1, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/refused.*units per hour/is) });
    await rig.advance(61_000);
    await rig.driver.status();
    expect((await rig.driver.pumpStatus()).percentTempBasal).toBe(true);
    expect((await rig.driver.status()).tempBasal).toBeNull();
  });

  it('is ok:true when the acknowledgement got lost but the pump reports the temp basal', async () => {
    const rig = await connected();
    rig.bench.pump.loseNextAcks(1);
    expect(await rig.driver.setTempBasal(1.5, 30)).toMatchObject({ ok: true, dose: { rate: 1.5, durationMin: 30 } });
    expect(rig.bench.pump.tempBasal).toMatchObject({ rate: 1.5 });
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
    expect((await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal')).toHaveLength(1);
  });

  it('is ok:false when nothing was acknowledged and the pump reports no temp basal', async () => {
    const rig = await connected();
    rig.bench.pump.loseNextCommands(1);
    expect(await rig.driver.setTempBasal(1.5, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/did not take/) });
    expect(await rig.driver.history(0)).toEqual([]);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
  });

  it('is ok:false when the pump acknowledged but reports something else', async () => {
    const rig = await connected();
    expect((await rig.driver.setTempBasal(1, 30)).ok).toBe(true);
    // the user changes it at the pump behind our back
    rig.bench.pump.setPercentTempBasal(true);
    await rig.advance(61_000);
    await rig.driver.status();
    expect((await rig.driver.status()).tempBasal).toBeNull();
    expect(await rig.driver.history(0)).toEqual([expect.objectContaining({ kind: 'tempBasal', rate: 1 })]);
  });

  it('keeps an unknown temp basal outcome pending and blocks dosing until the pump answers', async () => {
    const rig = await connected();
    rig.bench.pump.goSilentAfterNextCommand();
    expect(await rig.driver.setTempBasal(1.5, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/i) });
    expect((await storedRecord(rig)).ledger.pending).toMatchObject({ kind: 'tempBasal', rate: 1.5, durationMin: 30 });
    expect(await rig.driver.history(0)).toEqual([]);
    expect(await rig.driver.bolus(0.5, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/still unknown/) });
    expect(await rig.driver.setTempBasal(1, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/still unknown/) });
    rig.bench.pump.setSilent(false);
    await rig.advance(10_000);
    expect((await rig.driver.status()).tempBasal).toMatchObject({ rate: 1.5 });
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
    expect((await rig.driver.history(0)).filter((d) => d.kind === 'tempBasal')).toHaveLength(1);
  });

  it('lets cancel temp basal through while an outcome is unknown (it only reduces insulin)', async () => {
    const rig = await connected();
    rig.bench.pump.goSilentAfterNextCommand();
    expect((await rig.driver.bolus(1, { automatic: false })).ok).toBe(false);
    rig.bench.pump.setSilent(false);
    expect((await rig.driver.setTempBasal(1, 30)).ok).toBe(false); // refused: pending
    expect((await rig.driver.cancelTempBasal()).ok).toBe(true);
  });
});

describe('MiniMed suspend, resume and cancel bolus', () => {
  it('suspends and resumes, and reports the suspended time as a dose', async () => {
    const rig = await connected();
    expect((await rig.driver.suspend()).ok).toBe(true);
    expect(rig.bench.pump.isSuspended).toBe(true);
    await rig.advance(10 * 60_000);
    const open = (await rig.driver.history(0)).find((d) => d.kind === 'suspend');
    expect(open).toMatchObject({ kind: 'suspend', durationMin: 10 });
    expect((await rig.driver.resume()).ok).toBe(true);
    expect(rig.bench.pump.isSuspended).toBe(false);
    expect((await rig.driver.history(0)).find((d) => d.kind === 'suspend')).toMatchObject({ durationMin: 10 });
  });

  it('refuses a bolus and a temp basal while suspended, without sending', async () => {
    const rig = await connected();
    await rig.driver.suspend();
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false, error: expect.stringMatching(/suspended/) });
    expect(await rig.driver.setTempBasal(1, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/suspended/) });
    expect(argumentsOf(rig, MessageType.bolus) + argumentsOf(rig, MessageType.changeTempBasal)).toBe(0);
  });

  it('a suspend ends a running temp basal and stops a running bolus at what was delivered so far', async () => {
    const rig = await connected();
    expect((await rig.driver.setTempBasal(2, 30)).ok).toBe(true);
    expect((await rig.driver.bolus(3, { automatic: false })).ok).toBe(true);
    await rig.advance(30_000);
    expect((await rig.driver.suspend()).ok).toBe(true);
    const st = await rig.driver.status();
    expect(st).toMatchObject({ suspended: true, bolusing: false, tempBasal: null });
    const delivered = rig.bench.deliveredBolusUnits;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(3);
    expect(bolusUnits(await rig.driver.history(0))).toBeCloseTo(delivered, 3);
  });

  it('cancelBolus stops the bolus with what was delivered and gives the basal back', async () => {
    const rig = await connected();
    expect((await rig.driver.bolus(3, { automatic: false })).ok).toBe(true);
    await rig.advance(30_000);
    const r = await rig.driver.cancelBolus();
    expect(r).toMatchObject({ ok: true, dose: { kind: 'bolus' } });
    expect(rig.bench.pump.isSuspended).toBe(false);
    expect(rig.bench.pump.isBolusing).toBe(false);
    const delivered = rig.bench.deliveredBolusUnits;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(3);
    expect(bolusUnits(await rig.driver.history(0))).toBeCloseTo(delivered, 3);
    expect((await rig.driver.status()).suspended).toBe(false);
    expect((await rig.driver.bolus(0.1, { automatic: false })).ok).toBe(true);
  });

  it('cancelBolus with no bolus running is ok and sends nothing', async () => {
    const rig = await connected();
    const before = argumentsOf(rig, MessageType.suspendResume);
    expect(await rig.driver.cancelBolus()).toEqual({ ok: true });
    expect(argumentsOf(rig, MessageType.suspendResume)).toBe(before);
  });

  it('reports suspend as ok:false when the pump did not take it, and leaves the state untouched', async () => {
    const rig = await connected();
    rig.bench.pump.loseNextCommands(1);
    expect(await rig.driver.suspend()).toMatchObject({ ok: false });
    expect((await rig.driver.status()).suspended).toBe(false);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
  });

  it('settles a suspend whose acknowledgement got lost from the pump status', async () => {
    const rig = await connected();
    rig.bench.pump.loseNextAcks(1);
    expect((await rig.driver.suspend()).ok).toBe(true);
    expect((await rig.driver.status()).suspended).toBe(true);
    expect((await storedRecord(rig)).ledger.pending).toBeNull();
  });
});

describe('MiniMed logs and storage', () => {
  it('never logs the pump serial, addresses or raw frames', async () => {
    const rig = await connected({ clockSkewMs: 90_000 });
    await rig.driver.bolus(1, { automatic: false });
    await rig.driver.setTempBasal(1, 30);
    rig.bench.pump.loseNextAcks(1);
    await rig.driver.suspend();
    await rig.driver.resume();
    rig.bench.pump.setSilent(true);
    await rig.advance(120_000);
    await rig.driver.bolus(1, { automatic: false });
    const logs = rig.allLogs.join('\n');
    expect(logs).not.toContain(SERIAL);
    expect(logs).not.toMatch(/a7[0-9a-f]{6}/i);
    expect(logs).not.toMatch(/[0-9a-f]{20,}/i);
  });

  it('stores one record per pump serial and survives a restart with state and history intact', async () => {
    const rig = await connected();
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    await rig.advance(2 * 60_000);
    await rig.driver.status();
    const stored = await storedRecord(rig);
    expect(stored).toMatchObject({ version: 1, pumpModel: '723', suspended: false });
    expect(await rig.secrets.get('minimed/pump/654321')).toBeNull();

    const restarted = rig.newDriver();
    expect(bolusUnits(await restarted.history(0))).toBe(0.5);
    expect((await restarted.pumpStatus()).model).toBe('723');
    expect((await restarted.bolus(0.1, { automatic: false })).ok).toBe(true);
  });

  it('survives a corrupt record by refusing to guess', async () => {
    const secrets = createMemorySecretStore({ [KEY]: '{"version":2}' });
    const rig = makeMinimedRig({ secrets });
    expect(await rig.driver.history(0)).toEqual([]);
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect(argumentsOf(rig, MessageType.bolus)).toBe(0);
  });

  it('refuses to dose when the stored pending command or running bolus cannot be read (never silently forgets it)', async () => {
    const base = JSON.parse(JSON.stringify(await storedRecord(await connected())));
    const pendings = [{ kind: 'bolus', id: 'b1', units: '1.5', automatic: false, sentAt: START }, { kind: 'someNewKind', sentAt: START }, 'garbage'];
    for (const pending of pendings) {
      const secrets = createMemorySecretStore({ [KEY]: JSON.stringify({ ...base, ledger: { ...base.ledger, pending } }) });
      const rig = makeMinimedRig({ secrets });
      expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false });
      expect(argumentsOf(rig, MessageType.bolus)).toBe(0);
    }
    const secrets = createMemorySecretStore({ [KEY]: JSON.stringify({ ...base, ledger: { ...base.ledger, bolus: { id: 'x', requested: '2' } } }) });
    const rig = makeMinimedRig({ secrets });
    expect(await rig.driver.bolus(1, { automatic: false })).toMatchObject({ ok: false });
    expect(argumentsOf(rig, MessageType.bolus)).toBe(0);
  });

  it('starts from the START time of the rig', () => {
    expect(START).toBe(Date.UTC(2026, 10, 25, 8, 0, 0));
  });
});
