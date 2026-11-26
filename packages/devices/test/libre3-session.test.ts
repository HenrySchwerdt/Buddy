/**
 * Libre 3 CGM source against the protocol simulator: first-pair handshake, streaming, quality gating,
 * cached reconnect, sensor end, silence watchdog (ports of RoundWhiteDiscKit and LibreLoop, MIT).
 */
import { hex } from '@buddy/core';
import { p256 } from '@noble/curves/nist.js';
import { describe, expect, it } from 'vitest';
import { createLibre3Source, installAppIdentities, libre3DirectCgm, loadSensorState, pairLibre3Sensor } from '../src/libre3';
import { Libre3SensorSimulator } from '../src/libre3/simulator';
import { FAST_TIMING, T0, fakeLibre3Nfc, flush, makeCredentialJson, makeHarness, minute, rig, waitFor } from './libre3-helpers';

describe('plugin definition', () => {
  it('exposes the expected metadata and settings', () => {
    expect(libre3DirectCgm.meta).toMatchObject({ id: 'libre-3-direct', name: 'FreeStyle Libre 3 (direct)', manufacturer: 'Abbott', transport: 'ble', maturity: 'experimental' });
    expect(libre3DirectCgm.meta.description).toMatch(/not endorsed by Abbott/i);
    expect(libre3DirectCgm.defaultSettings).toEqual({ minuteByMinute: false, useNonActionable: false, appCredential: '' });
    expect(libre3DirectCgm.settings[0]!.fields.find((f) => f.key === 'appCredential')).toMatchObject({ kind: 'text', secret: true });
  });

  it('needs Bluetooth and a secret store', () => {
    const h = makeHarness();
    expect(() => libre3DirectCgm.create(libre3DirectCgm.defaultSettings, { ...h.ctx, ble: undefined })).toThrow(/Bluetooth/);
    expect(() => libre3DirectCgm.create(libre3DirectCgm.defaultSettings, { ...h.ctx, secrets: undefined })).toThrow(/secret store/);
  });

  it('refuses to start before a sensor is paired', async () => {
    const h = makeHarness(new Libre3SensorSimulator());
    const source = libre3DirectCgm.create(libre3DirectCgm.defaultSettings, h.ctx);
    await expect(source.start()).rejects.toThrow(/No Libre 3 sensor paired/);
  });
});

describe('first connection (full handshake)', () => {
  it('authorizes with the app credential, caches kAuth and streams readings at a 5-minute cadence', async () => {
    const r = await rig();
    await r.source.start();
    expect(r.sim.connections).toEqual([{ full: true, accepted: true }]);
    const state = (await loadSensorState(r.h.secrets))!;
    expect(state.kAuth).toHaveLength(16);
    expect(state.appIdentity).toBe('test');
    expect(state.peripheralId).toBe('libre3-sim');
    expect(r.source.status()).toMatchObject({ phase: 'streaming', serialNumber: '0RRC989AQ' });

    for (let i = 0; i < 11; i++) await minute(r, { mgdl: 100 + i, trend: 4 });
    const readings = await r.source.readings(0);
    // minute 0 (first frame), then one reading every 5 minutes
    expect(readings.map((x) => x.value)).toEqual([100, 105, 110]);
    expect(readings[0]).toMatchObject({ source: 'libre-3-direct', trend: 'fortyFiveUp', date: T0 });
    expect(readings[1]!.date - readings[0]!.date).toBe(5 * 60_000);
    expect(r.source.status().lifecycle).toBe('active');
    expect((await r.source.readings(readings[1]!.date)).map((x) => x.value)).toEqual([110]);
  });

  it('uses every minute when asked', async () => {
    const r = await rig({ settings: { minuteByMinute: true } });
    await r.source.start();
    for (let i = 0; i < 4; i++) await minute(r, { mgdl: 90 + i });
    expect((await r.source.readings(0)).map((x) => x.value)).toEqual([90, 91, 92, 93]);
  });

  it('takes the app credential from the plugin setting and keeps it in the secret store', async () => {
    const sim = new Libre3SensorSimulator({ lifeCount: 200 });
    const h = makeHarness(sim);
    const { json } = makeCredentialJson('from-setting');
    await installAppIdentities(h.secrets, makeCredentialJson('placeholder').json);
    await pairLibre3Sensor({ ...h.ctx, nfc: fakeLibre3Nfc(sim, 'active').nfc });
    await h.secrets.set('libre3.appIdentities', null);
    const source = createLibre3Source({ minuteByMinute: false, useNonActionable: false, appCredential: json }, h.ctx, { timing: FAST_TIMING, signingKeys: [sim.signingPublicKey] });
    await source.start();
    expect((await loadSensorState(h.secrets))!.appIdentity).toBe('from-setting');
    expect(await h.secrets.get('libre3.appIdentities')).toBe(json);
    await source.stop();
  });

  it('fails clearly without a credential when there is no cached key', async () => {
    const r = await rig();
    await r.h.secrets.set('libre3.appIdentities', null);
    await expect(r.source.start()).rejects.toThrow(/no app credential/);
    expect(r.sim.connections).toHaveLength(0);
  });

  it('tries the next credential when the sensor rejects the first certificate', async () => {
    const r = await rig({ identities: ['rejected', 'accepted'] });
    await r.source.start();
    expect(r.sim.connections.map((c) => c.accepted)).toEqual([false, true]);
    expect((await loadSensorState(r.h.secrets))!.appIdentity).toBe('accepted');
  });

  it('rejects a sensor certificate that does not verify against the signing keys', async () => {
    const r = await rig();
    const wrongKeys = createLibre3Source({ minuteByMinute: false, useNonActionable: false, appCredential: '' }, r.h.ctx, { timing: FAST_TIMING, signingKeys: [p256.getPublicKey(p256.utils.randomSecretKey(), false)] });
    await expect(wrongKeys.start()).rejects.toThrow(/certificate signature/);
    expect((await loadSensorState(r.h.secrets))!.kAuth).toBeNull();
  });

  it('needs the sensor to be found nearby', async () => {
    const h = makeHarness();
    const sim = new Libre3SensorSimulator();
    await installAppIdentities(h.secrets, makeCredentialJson('t').json);
    await pairLibre3Sensor({ ...h.ctx, nfc: fakeLibre3Nfc(sim, 'active').nfc });
    const source = createLibre3Source({ minuteByMinute: false, useNonActionable: false, appCredential: '' }, h.ctx, { timing: FAST_TIMING });
    await expect(source.start()).rejects.toThrow(/not found nearby/);
  });

  it('never logs key material', async () => {
    const r = await rig();
    await r.source.start();
    for (let i = 0; i < 3; i++) await minute(r);
    const kAuth = hex((await loadSensorState(r.h.secrets))!.kAuth!);
    const secrets = [kAuth, hex(r.sim.blePin), (await r.h.secrets.get('libre3.appIdentities'))!];
    for (const line of r.h.logs) for (const s of secrets) expect(line).not.toContain(s);
  });
});

describe('reading quality', () => {
  it('withholds warmup frames and readings inside the warmup window', async () => {
    const r = await rig({ lifeCount: 40 });
    await r.source.start();
    await minute(r, { mgdl: null });
    await minute(r, { mgdl: 110 }); // lifeCount 42 < 60 minutes of warmup
    expect(await r.source.readings(0)).toEqual([]);
    expect(r.source.status().lastIssue).toMatch(/sensorWarmup/);
    r.sim.lifeCount = 60;
    await minute(r, { mgdl: 112 });
    expect((await r.source.readings(0)).map((x) => x.value)).toEqual([112]);
  });

  it('withholds data-quality faults and abnormal sensor conditions', async () => {
    const r = await rig({ settings: { minuteByMinute: true } });
    await r.source.start();
    await minute(r, { mgdl: 110, dqError: 0xa000 });
    await minute(r, { mgdl: 110, sensorCondition: 1 });
    expect(await r.source.readings(0)).toEqual([]);
    expect(r.source.status().lastIssue).toBe('sensorCondition');
    await minute(r, { mgdl: 111 });
    expect((await r.source.readings(0)).map((x) => x.value)).toEqual([111]);
  });

  it('keeps "not actionable" readings away from the algorithm unless enabled', async () => {
    const strict = await rig({ settings: { minuteByMinute: true } });
    await strict.source.start();
    await minute(strict, { mgdl: 130, actionable: false });
    expect(await strict.source.readings(0)).toEqual([]);
    expect(strict.source.status().lastIssue).toBe('notActionable');

    const lenient = await rig({ settings: { minuteByMinute: true, useNonActionable: true } });
    await lenient.source.start();
    await minute(lenient, { mgdl: 130, actionable: false });
    expect((await lenient.source.readings(0)).map((x) => x.value)).toEqual([130]);
  });

  it('rejects implausible values and keeps the displayable low cap', async () => {
    const r = await rig({ settings: { minuteByMinute: true } });
    await r.source.start();
    await minute(r, { mgdl: 450 }); // above the plausible range
    await minute(r, { mgdl: 600 }); // above-range cap (501)
    await minute(r, { mgdl: 0 }); // unavailable
    expect(await r.source.readings(0)).toEqual([]);
    await minute(r, { mgdl: 30 }); // below range: shown as 39
    expect((await r.source.readings(0)).map((x) => x.value)).toEqual([39]);
  });

  it('maps the Libre arrows', async () => {
    const r = await rig({ settings: { minuteByMinute: true } });
    await r.source.start();
    for (const trend of [1, 2, 3, 4, 5, 0]) await minute(r, { mgdl: 110, trend });
    expect((await r.source.readings(0)).map((x) => x.trend)).toEqual(['singleDown', 'fortyFiveDown', 'flat', 'fortyFiveUp', 'singleUp', 'unknown']);
  });
});

describe('reconnect', () => {
  it('reconnects through the cached path (no certificate exchange) and keeps streaming', async () => {
    const r = await rig();
    await r.source.start();
    await minute(r, { mgdl: 100 });
    r.sim.drop();
    await waitFor(() => r.sim.connections.length === 2 && r.source.status().phase === 'streaming', 'cached reconnect');
    expect(r.sim.connections).toEqual([{ full: true, accepted: true }, { full: false, accepted: true }]);
    await minute(r, { mgdl: 140 });
    await minute(r, { mgdl: 141 });
    expect((await r.source.readings(0)).map((x) => x.value)).toEqual([100]);
    for (let i = 0; i < 4; i++) await minute(r, { mgdl: 142 + i });
    expect((await r.source.readings(0)).map((x) => x.value)).toEqual([100, 144]);
  });

  it('survives an app restart: a fresh source reconnects with the persisted state only', async () => {
    const r = await rig();
    await r.source.start();
    await minute(r);
    await r.source.stop();
    const restarted = createLibre3Source({ minuteByMinute: false, useNonActionable: false, appCredential: '' }, r.h.ctx, { timing: FAST_TIMING, signingKeys: [r.sim.signingPublicKey] });
    await restarted.start();
    expect(r.sim.connections.at(-1)).toEqual({ full: false, accepted: true });
    await restarted.stop();
  });

  it('never falls back to the full handshake when the sensor refuses the cached key, and asks for a re-pair', async () => {
    const r = await rig();
    await r.source.start();
    r.sim.authKey = null; // the sensor forgot the key
    r.sim.drop();
    await waitFor(() => r.source.status().needsRepair, 're-pair hint');
    expect(r.sim.connections.every((c, i) => (i === 0 ? c.full : !c.full))).toBe(true);
    expect(r.h.logs.join('\n')).toMatch(/Scan it with NFC again/);
    await r.source.stop();
  });

  it('forgets a stale peripheral id after repeated connect failures so the next attempt scans', async () => {
    const r = await rig();
    await r.source.start();
    await r.source.stop();
    r.h.ble.transport.connect = async () => {
      throw new Error('peripheral unknown');
    };
    for (let i = 0; i < 3; i++) await expect(r.source.start()).rejects.toThrow(/peripheral unknown/);
    expect((await loadSensorState(r.h.secrets))!.peripheralId).toBeNull();
  });

  it('stop() ends the connection and further drops do not reconnect', async () => {
    const r = await rig();
    await r.source.start();
    await r.source.stop();
    await new Promise((res) => setTimeout(res, 30));
    expect(r.sim.connections).toHaveLength(1);
    expect(r.source.status().phase).toBe('idle');
  });
});

describe('sensor end of life', () => {
  it('stops reading and reconnecting once the sensor reports termination, and refuses to start again', async () => {
    const r = await rig({ settings: { minuteByMinute: true } });
    await r.source.start();
    await minute(r, { mgdl: 100 });
    r.sim.emitPatchStatus({ errorData: 8, patchState: 8 });
    await flush(r.source);
    expect(r.source.status()).toMatchObject({ needsReplacement: true, endedNormally: false, attention: 'replaceSensor', phase: 'ended' });
    await minute(r, { mgdl: 101 });
    expect((await r.source.readings(0)).map((x) => x.value)).toEqual([100]);
    await new Promise((res) => setTimeout(res, 30));
    expect(r.sim.connections).toHaveLength(1);
    expect((await loadSensorState(r.h.secrets))!.needsReplacement).toBe(true);
    await expect(createLibre3Source({ minuteByMinute: false, useNonActionable: false, appCredential: '' }, r.h.ctx, { timing: FAST_TIMING }).start()).rejects.toThrow(/ended/);
  });

  it('reports a normal end of wear as expired and ignores a transient transmission error', async () => {
    const r = await rig({ settings: { minuteByMinute: true } });
    await r.source.start();
    r.sim.emitPatchStatus({ errorData: 7, patchState: 4 });
    await flush(r.source);
    expect(r.source.status()).toMatchObject({ attention: 'checkSensor', needsReplacement: false, phase: 'streaming' });
    await minute(r, { mgdl: 100 });
    expect(await r.source.readings(0)).toHaveLength(1);
    r.sim.emitPatchStatus({ errorData: 5, patchState: 5 });
    await flush(r.source);
    expect(r.source.status()).toMatchObject({ needsReplacement: true, endedNormally: true, attention: 'sensorEnded' });
  });

  it('blocks readings once the wear duration is reached', async () => {
    const r = await rig({ lifeCount: 21_599, settings: { minuteByMinute: true } });
    await r.source.start();
    await minute(r, { mgdl: 100 }); // life count 21600 = wear duration
    expect(await r.source.readings(0)).toEqual([]);
    expect(r.source.status().lastIssue).toMatch(/sensorExpired/);
  });
});

describe('silence watchdog', () => {
  it('reads patchStatus directly when it stays quiet and handles the result', async () => {
    const r = await rig();
    await r.source.start();
    await minute(r);
    r.h.clock.advance(61_000);
    await r.source.checkSilence();
    await flush(r.source);
    expect(r.source.status().lifecycle).toBe('active');
    expect(r.h.logs.join('\n')).not.toMatch(/read failed/);
  });

  it('drops a completely silent link so the reconnect starts clean', async () => {
    const r = await rig();
    await r.source.start();
    await minute(r);
    r.h.clock.advance(301_000);
    await r.source.checkSilence();
    await waitFor(() => r.sim.connections.length === 2 && r.source.status().phase === 'streaming', 'mute recovery reconnect');
    expect(r.sim.connections[1]).toEqual({ full: false, accepted: true });
    expect(r.h.logs.join('\n')).toMatch(/dropping the link/);
  });
});
