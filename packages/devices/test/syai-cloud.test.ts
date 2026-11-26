/**
 * Syai cloud tests: the AES-GCM envelope, login, token rotation and the bound-sensor lookup,
 * driven against an in-memory server (cloud-simulator). Wire formats follow SyaiKit
 * (MIT, © 2026 Nightscout Foundation); SyaiEnvelopedClientTests used live captures, which are not
 * reproduced here.
 */
import { describe, expect, it } from 'vitest';
import type { Logger } from '@buddy/core';
import {
  base64Encode,
  decryptResponse,
  deriveChannelKeys,
  encryptRequest,
  loginEncryptInfo,
  makeInstallDeviceId,
  signApiToken,
  SyaiCloudClient,
  SyaiFailure,
  SyaiHttpError,
  traceId,
  type ChannelSession,
  type SyaiAccount,
} from '../src/syai';
import { createSyaiCloudSim, type SimBoundSensor } from '../src/syai/cloud-simulator';
import { linearCoefficients } from '../src/syai/simulator';
import { ecb } from '@noble/ciphers/aes.js';

const MAC = 'AABBCCDDEEFF';
const NOW = 1_780_000_000_000;
const KEY_GROUP = Uint8Array.from({ length: 96 }, (_, i) => (i * 5 + 1) & 0xff);
const sensor: SimBoundSensor = { mac: MAC, keyGroup: KEY_GROUP, coefficients: linearCoefficients(), produceTime: 1_770_000_000_000, coeffUpdateTime: 1_770_346_120_828, activeTime: NOW - 3600_000 };

const seeded = (): ((n: number) => Uint8Array) => {
  let c = 1;
  return (n) => Uint8Array.from({ length: n }, () => (c = (c * 1103515245 + 12345) & 0x7fffffff) >> 8 & 0xff);
};

function setup(over: { sensor?: SimBoundSensor | null; accessTtlSec?: number } = {}) {
  const time = { t: NOW };
  const clock = { now: () => time.t };
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  const server = createSyaiCloudSim({ clock, email: 'me@example.com', password: 'hunter2-Secret', sensor: over.sensor === undefined ? sensor : over.sensor, accessTtlSec: over.accessTtlSec });
  const saved: SyaiAccount[] = [];
  const account: SyaiAccount = { refreshToken: '', accessToken: null, glucoseSecretKey: null, installDeviceId: makeInstallDeviceId(seeded()), email: null };
  const client = new SyaiCloudClient({ fetch: server.fetch, clock, log, random: seeded(), account, onAccountChange: (a) => saved.push(a) });
  return { client, server, time, saved, lines };
}

describe('secure channel', () => {
  const session: ChannelSession = { secretId: 's1', deviceId: 'dev', expireTime: NOW + 1000, ...deriveChannelKeys(new Uint8Array(32).fill(3), 's1', 'dev', NOW + 1000) };

  it('derives distinct 32-byte GCM and HMAC keys', () => {
    expect(session.gcmKey).toHaveLength(32);
    expect(session.hmacKey).toHaveLength(32);
    expect(session.gcmKey).not.toEqual(session.hmacKey);
  });

  it('seals and opens, binding deviceId|secretId as AAD', () => {
    const env = encryptRequest(session, 4, '{"a":1}', NOW, seeded());
    expect(env.seq).toBe(4);
    expect(env.nonceId).toMatch(/^\d+$/);
    expect(decryptResponse(session, env.text, env.mac, env.nonce)).toBe('{"a":1}');
    expect(() => decryptResponse({ ...session, secretId: 'other' }, env.text, env.mac, env.nonce)).toThrow(/GCM open failed/);
    expect(() => decryptResponse(session, '***', env.mac, env.nonce)).toThrow(/not valid base64/);
  });

  it('login encryptInfo is AES-256-ECB of the compact JSON, escaping quotes and backslashes', () => {
    const info = loginEncryptInfo('a"b@example.com', 'p\\w');
    const plain = new TextDecoder().decode(ecb(new TextEncoder().encode('miH5ngQ7z4NZU3JgZFq87Gg6v1Y7YJm9')).decrypt(Uint8Array.from(atob(info), (c) => c.charCodeAt(0))));
    expect(plain).toBe('{"email":"a\\"b@example.com","password":"p\\\\w"}');
  });

  it('request signatures are keyed MD5 hex', () => {
    const sig = signApiToken({ appName: 'Syai Tag', deviceId: 'd' }, '1700000000000');
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
    expect(sig).toBe(signApiToken({ appName: 'Syai Tag', deviceId: 'd' }, '1700000000000'));
    expect(sig).not.toBe(signApiToken({ appName: 'Syai Tag', deviceId: 'e' }, '1700000000000'));
  });

  it('install id and trace id have the shapes the official app uses', () => {
    expect(makeInstallDeviceId(seeded())).toMatch(/^Syai Tag:i:n:[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const t = traceId(NOW, seeded());
    expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('login and session', () => {
  it('logs in over the envelope and keeps the rotated tokens and glucoseSecretKey', async () => {
    const { client, saved, server } = setup();
    await client.login('me@example.com', 'hunter2-Secret');
    expect(server.calls).toEqual(['POST security/exchangeKey', 'GET user/apiToken', 'POST user/mail/login']);
    expect(client.hasSession).toBe(true);
    expect(client.currentAccount.glucoseSecretKey).toBe('SECRETKEY0000000');
    expect(client.currentAccount.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(saved.at(-1)).toEqual(client.currentAccount);
  });

  it('a wrong password is rejected with the server code and stores nothing', async () => {
    const { client, saved } = setup();
    await expect(client.login('me@example.com', 'nope')).rejects.toMatchObject({ kind: 'accountRejected', message: expect.stringContaining('User_InvalidParams') });
    expect(client.hasSession).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('refreshes an expired access token and persists the rotated pair', async () => {
    const { client, server, time } = setup();
    await client.login('me@example.com', 'hunter2-Secret');
    const first = client.currentAccount.accessToken;
    time.t += 2 * 3600_000; // past the 1 h lifetime
    await client.ensureAccessToken();
    expect(server.refreshes.count).toBe(1);
    expect(client.currentAccount.accessToken).not.toBe(first);
    const calls = server.calls.length;
    await client.ensureAccessToken(); // still valid: no network
    expect(server.calls).toHaveLength(calls);
  });

  it('a login elsewhere latches: no further refresh attempts, no silent re-login', async () => {
    const { client, server, time } = setup();
    await client.login('me@example.com', 'hunter2-Secret');
    time.t += 2 * 3600_000;
    server.faults.loginElsewhere = true;
    const err = await client.ensureAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyaiHttpError);
    expect((err as SyaiHttpError).isLoggedInElsewhere).toBe(true);
    expect((err as SyaiHttpError).isAuthFailure).toBe(false);
    const calls = server.calls.length;
    await expect(client.ensureAccessToken()).rejects.toMatchObject({ kind: 'accountLoggedOutElsewhere' });
    expect(server.calls).toHaveLength(calls);
    expect(client.isLockedOutElsewhere).toBe(true);
  });

  it('never logs the password, tokens, keys or the glucose secret', async () => {
    const { client, lines } = setup();
    await client.login('me@example.com', 'hunter2-Secret');
    await client.getBoundSensor();
    const blob = lines.join('\n');
    for (const secret of ['hunter2-Secret', 'SECRETKEY0000000', client.currentAccount.accessToken!, client.currentAccount.refreshToken, base64Encode(KEY_GROUP)]) expect(blob).not.toContain(secret);
  });
});

describe('bound sensor lookup', () => {
  it('returns the sensor with its own coefficients, key group, durations and start time', async () => {
    const { client, server } = setup();
    await client.login('me@example.com', 'hunter2-Secret');
    const bound = (await client.getBoundSensor())!;
    expect(server.calls.slice(-2)).toEqual(['GET deviceBind/getBindDevice', 'GET device/authInfo']);
    expect(bound.deviceInfo.mac).toBe(MAC);
    expect(bound.deviceInfo.coefficients).toEqual(linearCoefficients());
    expect(bound.deviceInfo.activeDurationSec).toBe(14 * 86400);
    expect(bound.deviceInfo.preheatDurationSec).toBe(1800);
    expect(bound.deviceInfo.serialNo).toBe('SN123');
    expect(bound.keyGroup).toEqual(KEY_GROUP);
    expect(bound.activatedAt).toBe(sensor.activeTime);
  });

  it('accepts a keyA delivered as 96 raw bytes', async () => {
    const { client } = setup({ sensor: { ...sensor, rawKeyA: true } });
    await client.login('me@example.com', 'hunter2-Secret');
    expect((await client.getBoundSensor())!.keyGroup).toEqual(KEY_GROUP);
  });

  it('an account with no sensor yields null', async () => {
    const { client } = setup({ sensor: null });
    await client.login('me@example.com', 'hunter2-Secret');
    expect(await client.getBoundSensor()).toBeNull();
  });

  it('a revoked access token surfaces as an auth failure the caller can recover from', async () => {
    const { client, server } = setup();
    await client.login('me@example.com', 'hunter2-Secret');
    server.faults.revokeAccessTokens = true;
    const err = await client.getBoundSensor().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyaiHttpError);
    expect((err as SyaiHttpError).isAuthFailure).toBe(true);
  });

  it('without a sensor calibration nothing is adopted (no default fallback)', async () => {
    const { client, server } = setup();
    await client.login('me@example.com', 'hunter2-Secret');
    // authInfo fails and the bound record alone lacks keyA: the failure must propagate.
    server.faults.wrongSignatures = false;
    server.sensor = { ...sensor, mac: MAC };
    const orig = server.fetch;
    const failing = async (...a: Parameters<typeof fetch>) => (String(a[0]).includes('device/authInfo') ? ({ status: 500, ok: false, text: async () => '{}' } as Response) : orig(...a));
    const c2 = new SyaiCloudClient({ fetch: failing as typeof fetch, clock: { now: () => NOW }, log: { info() {}, warn() {}, error() {} }, random: seeded(), account: client.currentAccount, onAccountChange: () => {} });
    await expect(c2.getBoundSensor()).rejects.toBeInstanceOf(SyaiFailure);
  });
});
