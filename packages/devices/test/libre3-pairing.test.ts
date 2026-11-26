/**
 * NFC pairing of the Libre 3 against a fake tag: order of operations, activation safety, persisted
 * state and receiver id (port of LibreLoop `LibreLoopPairingService.pair` and RoundWhiteDiscKit
 * `Libre3NFCActivationReader`, MIT).
 */
import { hex } from '@buddy/core';
import { describe, expect, it } from 'vitest';
import { installAppIdentities, pairLibre3Sensor, Libre3PairingError, loadSensorState, LIBRE3_SECRET_KEYS, AppIdentityError, parseAppIdentities } from '../src/libre3';
import { Libre3SensorSimulator } from '../src/libre3/simulator';
import { SERIAL, fakeLibre3Nfc, makeCredentialJson, makeHarness } from './libre3-helpers';

async function setup(state: 'fresh' | 'active') {
  const sim = new Libre3SensorSimulator();
  const h = makeHarness(sim);
  const fake = fakeLibre3Nfc(sim, state);
  await installAppIdentities(h.secrets, makeCredentialJson('test').json);
  return { sim, h, fake, ctx: { ...h.ctx, nfc: fake.nfc } };
}

describe('pairLibre3Sensor', () => {
  it('refuses to touch the sensor without an app credential', async () => {
    const sim = new Libre3SensorSimulator();
    const h = makeHarness(sim);
    const fake = fakeLibre3Nfc(sim, 'active');
    await expect(pairLibre3Sensor({ ...h.ctx, nfc: fake.nfc })).rejects.toMatchObject({ code: 'noAppCredential' });
    expect(fake.touched).toBe(0);
    expect(fake.commands).toHaveLength(0);
  });

  it('needs NFC and a secret store', async () => {
    const h = makeHarness();
    await expect(pairLibre3Sensor({ ...h.ctx })).rejects.toThrow(/NFC/);
    await expect(pairLibre3Sensor({ ...h.ctx, nfc: fakeLibre3Nfc(new Libre3SensorSimulator(), 'active').nfc, secrets: undefined })).rejects.toThrow(/secret store/);
  });

  it('does not activate a factory-fresh sensor unless allowed, and reports its patch info', async () => {
    const { ctx, fake, h } = await setup('fresh');
    const error = (await pairLibre3Sensor(ctx).catch((e: unknown) => e)) as Libre3PairingError;
    expect(error).toBeInstanceOf(Libre3PairingError);
    expect(error.code).toBe('activationNotAllowed');
    expect(error.patchInfo?.serialNumber).toBe(SERIAL);
    expect(fake.commands.map((c) => c.code)).toEqual([0xa1]);
    expect(await h.secrets.get(LIBRE3_SECRET_KEYS.sensor)).toBeNull();
  });

  it('activates a fresh sensor (0xA0) when allowed and persists address, PIN and durations immediately', async () => {
    const { ctx, fake, h, sim } = await setup('fresh');
    const info = await pairLibre3Sensor(ctx, { allowActivation: true });
    expect(info).toMatchObject({ serialNumber: SERIAL, bleAddress: sim.bleAddress, activated: true, command: 0xa0 });
    expect(fake.commands.map((c) => c.code)).toEqual([0xa1, 0xa0]);
    const state = (await loadSensorState(h.secrets))!;
    expect(state).toMatchObject({ serialNumber: SERIAL, bleAddress: sim.bleAddress, kAuth: null, wearDurationMinutes: 21600, warmupMinutes: 60, firmwareVersion: '1.4.2.30', needsReplacement: false });
    expect(hex(state.blePin)).toBe(hex(sim.blePin));
    // command parameters carry the receiver id that was stored
    expect(fake.commands[1]!.params.slice(8, 16)).toBe(info.receiverIdHex);
  });

  it('switches the receiver of an active sensor (0xA8) with a stable receiver id across pairings', async () => {
    const { ctx, fake } = await setup('active');
    const first = await pairLibre3Sensor(ctx);
    const second = await pairLibre3Sensor(ctx);
    expect(first).toMatchObject({ activated: false, command: 0xa8 });
    expect(second.receiverIdHex).toBe(first.receiverIdHex);
    expect(fake.commands.filter((c) => c.code === 0xa8)).toHaveLength(2);
  });

  it('honours an explicit receiver id or an account derivation (recovery)', async () => {
    const { ctx, fake } = await setup('active');
    const byId = await pairLibre3Sensor(ctx, { receiverId: 0x6f0d8378 });
    expect(byId.receiverIdHex).toBe('78830d6f');
    expect(fake.commands.at(-1)!.params.slice(8, 16)).toBe('78830d6f');
    const byAccount = await pairLibre3Sensor(ctx, { account: { id: '2977dec2-492a-11ea-9702-0242ac110002', derivation: 'libreByAbbott' } });
    expect(byAccount.receiverIdHex).toBe('c7f95683');
  });

  it('refuses switchReceiverOnly on a fresh sensor', async () => {
    const { ctx } = await setup('fresh');
    await expect(pairLibre3Sensor(ctx, { switchReceiverOnly: true, allowActivation: true })).rejects.toMatchObject({ code: 'unexpectedSensorState' });
  });

  it('re-pairing the same sensor drops the cached key but keeps the backfill watermark; another sensor starts clean', async () => {
    const { ctx, h } = await setup('active');
    await pairLibre3Sensor(ctx);
    const paired = (await loadSensorState(h.secrets))!;
    await h.secrets.set(LIBRE3_SECRET_KEYS.sensor, JSON.stringify({ ...JSON.parse((await h.secrets.get(LIBRE3_SECRET_KEYS.sensor))!), kAuth: '00112233445566778899aabbccddeeff', lastLifeCount: 777, peripheralId: 'abc' }));
    expect((await loadSensorState(h.secrets))!.kAuth).not.toBeNull();
    await pairLibre3Sensor(ctx);
    const again = (await loadSensorState(h.secrets))!;
    expect(again).toMatchObject({ kAuth: null, lastLifeCount: 777, peripheralId: 'abc', serialNumber: paired.serialNumber });
  });

  it('reports NFC failures as pairing errors', async () => {
    const { ctx } = await setup('active');
    const broken = { ...ctx, nfc: { isSupported: async () => true, withIso15693Tag: async () => { throw new Error('tag lost'); } } };
    await expect(pairLibre3Sensor(broken)).rejects.toMatchObject({ code: 'nfcFailed' });
    const unsupported = { ...ctx, nfc: { isSupported: async () => false, withIso15693Tag: async () => undefined as never } };
    await expect(pairLibre3Sensor(unsupported)).rejects.toMatchObject({ code: 'nfcNotSupported' });
  });
});

describe('app credential', () => {
  it('validates the format and that the key matches the certificate', async () => {
    const { json } = makeCredentialJson('a', 'b');
    expect(parseAppIdentities(json).map((i) => i.label)).toEqual(['a', 'b']);
    const parsed = JSON.parse(json) as { identities: { certificateHex: string }[] };
    const swapped = JSON.stringify({ ...parsed, identities: [{ ...parsed.identities[0], certificateHex: parsed.identities[1]!.certificateHex, label: 'x', privateKeyHex: (JSON.parse(json) as { identities: { privateKeyHex: string }[] }).identities[0]!.privateKeyHex }] });
    expect(() => parseAppIdentities(swapped)).toThrow(AppIdentityError);
    expect(() => parseAppIdentities('{"format":2}')).toThrow(/Unsupported/);
    expect(() => parseAppIdentities('nope')).toThrow(/JSON/);
    const h = makeHarness();
    await expect(installAppIdentities(h.secrets, '{"format":1,"curve":"P-256","identities":[]}')).rejects.toThrow(/no identities/);
  });
});
