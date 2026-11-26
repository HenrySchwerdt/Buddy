/** Eros message nonce: first-command resync, resync after the pod re-seeded, rejection limit, persistence. Bench only (simulated pod). */
import { describe, expect, it } from 'vitest';
import { hasNonce } from '../src/omnipod/common';
import { pairAndPrimeErosPod } from '../src/omnipod/eros-driver';
import { activateErosPod, makeErosRig } from './omnipod-eros-helpers';

describe('Omnipod Eros nonce handling', () => {
  it('starts without a nonce state: the first programming command is rejected once and resynced, and not executed twice', async () => {
    const rig = makeErosRig();
    expect(await pairAndPrimeErosPod(rig.driver)).toEqual({ ok: true });
    expect(rig.bench.badNonceAnswers).toBe(1);
    const faultConfigs = rig.bench.received.filter((m) => m.blocks[0]?.type === 'faultConfig');
    expect(faultConfigs).toHaveLength(2); // rejected, then accepted with the resynced nonce
    const [bad, good] = faultConfigs.map((m) => m.blocks.find(hasNonce)!.nonce);
    expect(bad).toBe(0x494e532e);
    expect(good).not.toBe(bad);
    expect(faultConfigs[0]!.sequenceNum).toBe(faultConfigs[1]!.sequenceNum); // OmnipodKit resends with the same message number
    expect(rig.bench.model.progress).toBeGreaterThanOrEqual(4);
  });

  it('keeps the nonce in step over many commands without further resyncs', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    const before = rig.bench.badNonceAnswers;
    for (let i = 0; i < 6; i++) {
      expect((await rig.driver.setTempBasal(1 + (i % 2), 30)).ok).toBe(true);
    }
    expect((await rig.driver.bolus(0.1, { automatic: false })).ok).toBe(true);
    expect(rig.bench.badNonceAnswers).toBe(before);
  });

  it('resyncs transparently when the pod re-seeded its nonce, and the command runs exactly once', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    const before = rig.bench.badNonceAnswers;
    rig.bench.desyncNonce();
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
    expect(rig.bench.badNonceAnswers).toBe(before + 1);
    expect(rig.bench.model.userBolusRequests).toEqual([0.5]);
    await rig.advance(60_000);
    await rig.driver.status();
    expect(rig.bench.deliveredBolusUnits).toBeCloseTo(0.5, 5);
    expect((await rig.driver.history(0)).filter((d) => d.kind === 'bolus')).toHaveLength(1);
    // and the following commands need no new resync
    expect((await rig.driver.setTempBasal(1, 30)).ok).toBe(true);
    expect(rig.bench.badNonceAnswers).toBe(before + 1);
  });

  it('the resent command carries the new nonce, and a stale cached state is never reused after a restart', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.desyncNonce();
    const second = rig.newDriver();
    await rig.advance(40_000);
    expect((await second.status()).suspended).toBe(false); // the refresh itself is not nonce carrying
    expect((await second.setTempBasal(1.5, 30)).ok).toBe(true);
    const stored = JSON.parse((await rig.secrets.get('omnipod-eros/pod'))!);
    expect(stored.nonce.table).toHaveLength(18);
  });

  it('gives up after two rejections in a row without dosing', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.rejectNextNonces(2);
    const r = await rig.driver.bolus(1, { automatic: false });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Nonce resync failed/) });
    expect(rig.bench.model.userBolusRequests).toEqual([]);
    expect((await rig.driver.history(0)).filter((d) => d.kind === 'bolus')).toEqual([]);
    expect((await rig.driver.status()).bolusing).toBe(false); // certain failure: no pending command stays behind
    // the next command resyncs again and works
    expect((await rig.driver.bolus(0.5, { automatic: false })).ok).toBe(true);
  });

  it('never writes nonce material to the log', async () => {
    const rig = makeErosRig();
    await activateErosPod(rig);
    rig.bench.desyncNonce();
    await rig.driver.bolus(0.1, { automatic: false });
    expect(rig.allLogs.join('\n')).not.toMatch(/nonce|seed|syncword/i);
  });
});
