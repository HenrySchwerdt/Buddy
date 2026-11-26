/**
 * Syai Ultra CGM source: wires the cloud client (sensor record), the BLE session and the manager
 * into a `CgmSource` with a reconnect loop. Replaces SyaiCGMManager.swift (+Pairing, +Reconnect,
 * +Session) from SyaiKit (MIT, © 2026 Nightscout Foundation), without the LoopKit glue.
 *
 * Sensor activation is not implemented: the sensor must already be activated and bound to the
 * user's Syai account (for example with the official app). This source takes over that sensor.
 */
import type { CgmSource, DeviceContext, DeviceMeta, GlucoseReading } from '@buddy/core';
import { errorOf, ReadingBuffer, Sleeper } from '../dexcom-g6/ble-common';
import { systemRandom, type RandomSource } from './ble-auth';
import { SyaiCloudClient, makeInstallDeviceId, type ClientIdentity, type SyaiAccount } from './cloud-client';
import { SYAI_ID } from './constants';
import { SyaiFailure, SyaiHttpError } from './errors';
import type { SyaiLifecycle } from './lifecycle';
import { SyaiManager } from './manager';
import { macFromApplicatorCode } from './provisioning';
import { DEFAULT_SESSION_TIMEOUTS, SyaiSession, type SessionTimeouts } from './session';
import { EMPTY_SYAI_STATE, SYAI_ACCOUNT_KEY, SYAI_STATE_KEY, keyGroupBytes, parseAccount, parseSyaiState, sensorRecordFrom, serializeAccount, serializeSyaiState, type SyaiSensorRecord, type SyaiState } from './state';

export interface SyaiSettings {
  readonly [key: string]: string | number | boolean;
  email: string;
  password: string;
  /** Optional: pin the sensor by the MAC on the applicator QR code. Empty = the sensor bound to the account. */
  sensorMac: string;
}

export const SYAI_META: DeviceMeta = {
  id: SYAI_ID,
  name: 'Syai Ultra',
  manufacturer: 'Syai',
  description:
    'Reads an already activated Syai Ultra (X1, firmware V1.6 to V2.0) over Bluetooth, using the sensor keys and calibration of your own Syai account. The official Syai app must not be connected to the sensor at the same time.',
  transport: 'ble',
  maturity: 'experimental',
};

/** Accepts a bare MAC or the QR payload (`AA:BB:..`); empty means "use the account's sensor". */
export function normalizeSensorMac(raw: string): string | null {
  if (raw.trim() === '') return null;
  const mac = macFromApplicatorCode(raw);
  if (!mac) throw new Error('Syai sensor MAC must be 12 hex digits (the code on the applicator), or be left empty');
  return mac;
}

export interface SyaiRetryTiming {
  /** No frame for this long on a live link forces a reconnect. */
  readonly staleLinkMs: number;
  /** After a dropped link (strong "it is right here" signal): retry near-continuously. */
  readonly droppedRetryMs: number;
  readonly noSensorRetryMs: number;
  readonly authRetryMs: number;
  readonly cloudRetryMs: number;
  readonly bluetoothRetryMs: number;
  /** While the sensor is expired or failed: how often to look for a newly bound sensor. */
  readonly replacementCheckMs: number;
}

export const DEFAULT_RETRY_TIMING: SyaiRetryTiming = {
  staleLinkMs: 6 * 60_000,
  droppedRetryMs: 5_000,
  noSensorRetryMs: 15_000,
  authRetryMs: 60_000,
  cloudRetryMs: 5 * 60_000,
  bluetoothRetryMs: 15_000,
  replacementCheckMs: 15 * 60_000,
};

export interface SyaiSourceOptions {
  readonly timing?: Partial<SyaiRetryTiming>;
  readonly sessionTimeouts?: Partial<SessionTimeouts>;
  readonly random?: RandomSource;
  readonly baseUrl?: string;
  readonly identity?: Partial<ClientIdentity>;
}

export interface SyaiStatus {
  readonly mac: string | null;
  readonly connected: boolean;
  readonly lifecycle: SyaiLifecycle;
  readonly fault: SyaiState['fault'];
  /** Last problem worth showing the user, or null. */
  readonly message: string | null;
}

export interface SyaiCgmSource extends CgmSource {
  status(): SyaiStatus;
}

export function createSyaiSource(settings: SyaiSettings, ctx: DeviceContext, options: SyaiSourceOptions = {}): SyaiCgmSource {
  const ble = ctx.ble;
  if (!ble) throw new Error('Syai Ultra needs Bluetooth, but no BLE transport is available on this device');
  const pinnedMac = normalizeSensorMac(String(settings.sensorMac ?? ''));
  const email = String(settings.email ?? '').trim();
  const password = String(settings.password ?? '');
  const timing: SyaiRetryTiming = { ...DEFAULT_RETRY_TIMING, ...options.timing };
  const timeouts: SessionTimeouts = { ...DEFAULT_SESSION_TIMEOUTS, ...options.sessionTimeouts };
  const random = options.random ?? systemRandom;
  const buffer = new ReadingBuffer();
  const sleeper = new Sleeper();

  let manager: SyaiManager | null = null;
  let client: SyaiCloudClient | null = null;
  let activeSession: SyaiSession | null = null;
  let running = false;
  let loop: Promise<void> = Promise.resolve();
  let message: string | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  let reprovision = false;
  let lastReplacementCheck = 0;

  const persist = (key: string, value: string) => {
    const secrets = ctx.secrets;
    if (!secrets) return;
    persistChain = persistChain.then(() => secrets.set(key, value)).catch((e: unknown) => ctx.log.error(`Syai: could not persist ${key}: ${errorOf(e).message}`));
  };

  async function loadAccount(): Promise<SyaiAccount> {
    const stored = parseAccount((await ctx.secrets?.get(SYAI_ACCOUNT_KEY)) ?? null);
    const installDeviceId = stored.installDeviceId ?? makeInstallDeviceId(random);
    // Tokens of another account are discarded; the install id stays stable.
    const foreign = stored.email !== null && email !== '' && stored.email.toLowerCase() !== email.toLowerCase();
    const account: SyaiAccount = foreign ? { refreshToken: '', accessToken: null, glucoseSecretKey: null, installDeviceId, email } : { ...stored, installDeviceId };
    persist(SYAI_ACCOUNT_KEY, serializeAccount(account));
    return account;
  }

  async function cloud(): Promise<SyaiCloudClient> {
    if (client) return client;
    client = new SyaiCloudClient({
      fetch: ctx.fetch,
      clock: ctx.clock,
      log: ctx.log,
      random,
      account: await loadAccount(),
      baseUrl: options.baseUrl,
      identity: options.identity,
      onAccountChange: (a) => persist(SYAI_ACCOUNT_KEY, serializeAccount({ ...a, email: a.email ?? (email || null) })),
    });
    return client;
  }

  /** Fetches the account's bound sensor, logging in (or once re-logging in) as needed. */
  async function fetchBoundSensor(): Promise<SyaiSensorRecord | null> {
    const c = await cloud();
    const login = async () => {
      if (email === '' || password === '') throw new SyaiFailure('notConfigured', 'Enter your Syai account email and password in the Syai Ultra settings.');
      await c.login(email, password);
    };
    if (!c.hasSession) await login();
    let bound;
    try {
      bound = await c.getBoundSensor();
    } catch (e) {
      if (!(e instanceof SyaiHttpError && e.isAuthFailure)) throw e;
      await login(); // dead session: one silent re-login, never for "logged in elsewhere"
      bound = await c.getBoundSensor();
    }
    return bound ? sensorRecordFrom(bound) : null;
  }

  async function ensureSensor(mgr: SyaiManager): Promise<SyaiSensorRecord | null> {
    const current = mgr.state.sensor;
    const wantsOther = current !== null && pinnedMac !== null && current.deviceInfo.mac !== pinnedMac;
    const lc = mgr.lifecycle(ctx.clock.now(), false).phase;
    const retired = lc === 'expired' || lc === 'failed' || lc === 'unactivated';
    const dueForReplacementCheck = retired && ctx.clock.now() - lastReplacementCheck >= timing.replacementCheckMs;
    if (current && !wantsOther && !reprovision && !dueForReplacementCheck && keyGroupBytes(current)) return current;

    lastReplacementCheck = ctx.clock.now();
    const bound = await fetchBoundSensor();
    reprovision = false;
    if (!bound) {
      message = current && retired ? null : 'No sensor is bound to your Syai account. Activate one with the official Syai app first.';
      return current && !wantsOther ? current : null;
    }
    if (pinnedMac && bound.deviceInfo.mac !== pinnedMac) {
      message = `Your Syai account has sensor ${bound.deviceInfo.mac} bound, not the pinned ${pinnedMac}.`;
      return null;
    }
    if (current && current.deviceInfo.mac === bound.deviceInfo.mac && retired) return current; // same dead sensor: nothing new
    ctx.log.info(`Syai: adopting sensor …${bound.deviceInfo.mac.slice(-4)} from the account`);
    mgr.adoptSensor(bound);
    message = null;
    return bound;
  }

  /** Runs one authenticated link until it closes or goes silent; returns how the caller should wait. */
  async function runSession(mgr: SyaiManager, record: SyaiSensorRecord): Promise<void> {
    const keyGroup = keyGroupBytes(record);
    if (!keyGroup) {
      reprovision = true;
      return;
    }
    const session = await SyaiSession.connect(
      { ble: ble!, clock: ctx.clock, log: ctx.log, random },
      { mac: record.deviceInfo.mac, keyGroup, peripheralId: record.peripheralId },
      { onFrame: (f) => mgr.handleFrame(f), onBatch: (b) => mgr.handleBatch(b) },
      timeouts,
    );
    activeSession = session;
    message = null;
    mgr.setPeripheralId(session.peripheralId);
    mgr.noteCmdState(session.reportedCmdState);
    const watchdog = new Sleeper();
    let watching = true;
    const stale = (async () => {
      const started = ctx.clock.now();
      while (watching && running) {
        await watchdog.sleep(timing.staleLinkMs);
        if (!watching || !running) return;
        // A fault is surfaced on its own; reconnect churn on a failing sensor helps nobody.
        if (mgr.state.fault) return;
        if (ctx.clock.now() - (mgr.lastFrameAt ?? started) >= timing.staleLinkMs) {
          ctx.log.info('Syai: no frame within the stale window; forcing a reconnect');
          await session.disconnect();
          return;
        }
      }
    })();
    try {
      await Promise.race([session.closed, stale]);
    } finally {
      watching = false;
      watchdog.cancelAll();
      activeSession = null;
      await session.disconnect();
    }
  }

  async function backoff(ms: number): Promise<void> {
    if (running) await sleeper.sleep(ms);
  }

  async function runLoop(mgr: SyaiManager): Promise<void> {
    while (running) {
      try {
        const record = await ensureSensor(mgr);
        if (!record) {
          await backoff(timing.cloudRetryMs);
          continue;
        }
        const retired = ['expired', 'failed', 'unactivated'].includes(mgr.lifecycle(ctx.clock.now(), false).phase);
        if (retired) {
          // Nothing to stream; keep checking the account for a replacement sensor.
          await backoff(Math.min(timing.replacementCheckMs, timing.cloudRetryMs));
          continue;
        }
        await runSession(mgr, record);
        await backoff(timing.droppedRetryMs);
      } catch (e) {
        if (!running) return;
        const err = errorOf(e);
        const kind = err instanceof SyaiFailure ? err.kind : 'network';
        ctx.log.warn(`Syai: ${kind}: ${err.message}`);
        message = err.message;
        if (kind === 'unsupportedFirmware') return; // never retried: the sensor stays untouched
        if (kind === 'authFailed') reprovision = true; // keys may have rotated: fetch the record again
        const wait: Record<string, number> = {
          droppedAfterConnect: timing.droppedRetryMs,
          noSensorFound: timing.noSensorRetryMs,
          bluetoothUnavailable: timing.bluetoothRetryMs,
          authFailed: timing.authRetryMs,
        };
        await backoff(wait[kind] ?? timing.cloudRetryMs);
      }
    }
  }

  return {
    meta: SYAI_META,
    async start() {
      if (running) return;
      if (!manager) {
        const state = parseSyaiState((await ctx.secrets?.get(SYAI_STATE_KEY)) ?? null);
        manager = new SyaiManager(state, {
          clock: ctx.clock,
          log: ctx.log,
          persist: (s) => persist(SYAI_STATE_KEY, serializeSyaiState(s)),
          onReading: (syncId, reading: GlucoseReading) => void buffer.add(syncId, reading),
          requestBackfill: (start, count) => (activeSession ? activeSession.requestHistorical(start, count) : Promise.reject(new Error('no live session'))),
        });
      }
      running = true;
      const mgr = manager;
      loop = runLoop(mgr).catch((e: unknown) => ctx.log.error(`Syai: loop ended: ${errorOf(e).message}`));
    },
    async stop() {
      running = false;
      sleeper.cancelAll();
      await activeSession?.disconnect();
      await loop;
      await persistChain;
    },
    async readings(since) {
      return buffer.since(since);
    },
    status() {
      const s = manager?.state ?? EMPTY_SYAI_STATE;
      return {
        mac: s.sensor?.deviceInfo.mac ?? null,
        connected: activeSession !== null,
        lifecycle: manager?.lifecycle(ctx.clock.now(), activeSession !== null) ?? { phase: 'noSensor' },
        fault: s.fault,
        message,
      };
    },
  };
}
