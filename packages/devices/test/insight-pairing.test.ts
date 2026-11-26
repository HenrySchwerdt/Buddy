import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, silentLogger, type SecretStore } from '@buddy/core';
import { createFakeBle } from '../src/testkit';
import { BridgeError, createInsightDriver, InsightBridgeSimulator, INSIGHT_DEFAULTS, pairInsightBridge, scanInsightBridges, type PairingEvent } from '../src/insight';
import { credentialsKey, decodeCredentials, loadCredentials } from '../src/insight/credentials';
import { FAST, START, BRIDGE_ID } from './insight-helpers';

function setup(opts: { autoConfirmAndroid?: boolean; secrets?: SecretStore } = {}) {
  const clock = { now: () => START };
  const ble = createFakeBle();
  const sim = new InsightBridgeSimulator({ clock, bridgeId: BRIDGE_ID, paired: null, autoConfirmAndroid: opts.autoConfirmAndroid ?? true });
  ble.add(sim);
  const secrets = opts.secrets ?? createMemorySecretStore();
  const events: PairingEvent[] = [];
  const start = () => pairInsightBridge({ ble: ble.transport, clock, log: silentLogger, peripheralId: sim.id, name: 'InsightBridge-3210', secrets, timeouts: FAST, onEvent: (e) => events.push(e) });
  return { clock, ble, sim, secrets, events, start };
}

const tick = () => new Promise((r) => setTimeout(r, 30));
/** Polls instead of sleeping a fixed time: the pairing steps are asynchronous BLE round trips. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Insight pairing', () => {
  it('finds bridges by service UUID', async () => {
    const t = setup();
    const found = await scanInsightBridges(t.ble.transport, { timeoutMs: 20 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: t.sim.id });
    expect(found[0]!.name.startsWith('InsightBridge-')).toBe(true);
  });

  it('pairs after both users confirmed the same code, stores the key and the driver can use it', async () => {
    const t = setup();
    t.sim.enterPairingMode();
    const pairing = t.start();
    await until(() => t.events.some((e) => e.kind === 'confirmCode'));
    const shown = t.events.find((e) => e.kind === 'confirmCode');
    expect(shown && shown.kind === 'confirmCode' && shown.code).toMatch(/^\d{6}$/);
    expect(shown && shown.kind === 'confirmCode' && shown.code).toBe(t.sim.pairingCode);
    pairing.confirmCode(true);
    const result = await pairing.done;
    expect(result.bridgeId).toBe(BRIDGE_ID);
    expect(t.events.map((e) => e.kind)).toEqual(['waitingForBridge', 'confirmCode', 'waitingForBridgeConfirmation', 'completed']);
    const stored = await loadCredentials(t.secrets, BRIDGE_ID);
    expect(stored?.ltk).toEqual(t.sim.pairedLtk);
    expect(decodeCredentials(result.pairingSecret)?.ltk).toEqual(t.sim.pairedLtk);

    // Use the pairing secret as the secret setting only (no SecretStore entry).
    const driver = createInsightDriver(
      { ...INSIGHT_DEFAULTS, bridgeId: result.bridgeId, bridgePeripheral: result.peripheralId, pairingSecret: result.pairingSecret, basalProfile: '1.0' },
      { clock: t.clock, log: silentLogger, fetch, ble: t.ble.transport, secrets: createMemorySecretStore() },
      { timeouts: FAST },
    );
    await driver.connect();
    expect((await driver.status()).reservoirUnits).not.toBeNull();
    expect(t.sim.pairedClientId).toBe(decodeCredentials(result.pairingSecret)?.clientId);
  });

  it('is refused when the bridge is not in pairing mode', async () => {
    const t = setup();
    const pairing = t.start();
    await expect(pairing.done).rejects.toMatchObject({ kind: 'pairingRejected', detail: 'notInPairingMode' });
    expect(await t.secrets.get(credentialsKey(BRIDGE_ID))).toBeNull();
    expect(t.events.at(-1)?.kind).toBe('failed');
  });

  it('stores nothing when the user says the codes differ, and tells the bridge', async () => {
    const t = setup();
    t.sim.enterPairingMode();
    const pairing = t.start();
    await until(() => t.events.some((e) => e.kind === 'confirmCode'));
    pairing.confirmCode(false);
    await expect(pairing.done).rejects.toMatchObject({ kind: 'pairingRejected', detail: 'userRejected' });
    expect(await t.secrets.get(credentialsKey(BRIDGE_ID))).toBeNull();
    expect(t.sim.isPaired).toBe(false);
  });

  it('waits for the Android confirmation and fails if the Android user refuses', async () => {
    const t = setup({ autoConfirmAndroid: false });
    t.sim.enterPairingMode();
    const pairing = t.start();
    await until(() => t.events.some((e) => e.kind === 'confirmCode'));
    pairing.confirmCode(true);
    await until(() => t.events.some((e) => e.kind === 'waitingForBridgeConfirmation'));
    await tick();
    expect(t.events.at(-1)?.kind).toBe('waitingForBridgeConfirmation');
    t.sim.confirmPairingOnAndroid(false);
    await expect(pairing.done).rejects.toBeInstanceOf(BridgeError);
    expect(await t.secrets.get(credentialsKey(BRIDGE_ID))).toBeNull();
    expect(t.sim.isPaired).toBe(false);
  });

  it('completes when the Android user confirms after this phone did', async () => {
    const t = setup({ autoConfirmAndroid: false });
    t.sim.enterPairingMode();
    const pairing = t.start();
    await until(() => t.events.some((e) => e.kind === 'confirmCode'));
    pairing.confirmCode(true);
    await until(() => t.events.some((e) => e.kind === 'waitingForBridgeConfirmation'));
    await tick();
    t.sim.confirmPairingOnAndroid(true);
    await expect(pairing.done).resolves.toMatchObject({ bridgeId: BRIDGE_ID });
  });

  it('fails with a timeout when the bridge never answers and can be cancelled before a code is shown', async () => {
    const t = setup();
    t.sim.onWrite = () => undefined; // a silent device
    const quiet = t.start();
    await expect(quiet.done).rejects.toMatchObject({ kind: 'timeout' });
    const t2 = setup();
    t2.sim.onWrite = () => undefined;
    const p = t2.start();
    await until(() => t2.events.some((e) => e.kind === 'waitingForBridge'));
    p.cancel();
    await expect(p.done).rejects.toMatchObject({ kind: 'pairingRejected' });
  });

  it('refuses when Bluetooth is off', async () => {
    const clock = { now: () => START };
    const ble = createFakeBle('poweredOff');
    const p = pairInsightBridge({ ble: ble.transport, clock, log: silentLogger, peripheralId: 'x', timeouts: FAST });
    await expect(p.done).rejects.toMatchObject({ kind: 'bluetoothUnavailable' });
    await expect(scanInsightBridges(ble.transport, { timeoutMs: 10 })).rejects.toMatchObject({ kind: 'bluetoothUnavailable' });
  });
});
