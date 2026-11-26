/**
 * In-memory Syai cloud for tests: the server half of the secure channel (ECDH + HKDF + AES-GCM
 * envelope, HMAC request signature) and the endpoints the driver uses (apiToken, login, refresh,
 * getBindDevice, authInfo). No Swift counterpart; formats follow SyaiKit (MIT, © 2026 Nightscout
 * Foundation).
 */
import type { Bytes, Clock } from '@buddy/core';
import { concatBytes } from '@buddy/core';
import { ecb, gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64Decode, base64Encode, hexUpper, utf8Decode, utf8Encode } from './bytes';
import { LOGIN_AES_KEY, deriveChannelKeys, sessionAad, signApiToken, signAuthInfo, signLogin } from './cloud-channel';
import { deriveWrapKey } from './provisioning';

export interface SimBoundSensor {
  readonly mac: string;
  /** 96 raw bytes. */
  readonly keyGroup: Bytes;
  readonly coefficients: readonly number[];
  readonly deviceVersion?: string;
  readonly produceTime: number;
  readonly coeffUpdateTime: number;
  readonly activeTime: number;
  readonly activeExpireTimeMs?: number;
  readonly preheatPeriodTimeMs?: number;
  /** Delivers keyA as 96 raw bytes instead of the 192-character hex string. */
  readonly rawKeyA?: boolean;
}

export interface SyaiCloudSimOptions {
  readonly clock: Clock;
  readonly email: string;
  readonly password: string;
  readonly glucoseSecretKey?: string;
  readonly sensor: SimBoundSensor | null;
  /** Access-token lifetime in seconds (default 3600). */
  readonly accessTtlSec?: number;
}

export interface SyaiCloudSim {
  readonly fetch: typeof fetch;
  /** `METHOD path` of every call, in order. */
  readonly calls: string[];
  readonly logins: { count: number };
  readonly refreshes: { count: number };
  /** Fault injection. */
  readonly faults: { loginElsewhere: boolean; revokeAccessTokens: boolean; wrongSignatures: boolean };
  sensor: SimBoundSensor | null;
}

const b64url = (b: Bytes): string => base64Encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const wrap = (plain: Bytes | string, key: string): string => base64Encode(ecb(utf8Encode(key)).encrypt(typeof plain === 'string' ? utf8Encode(plain) : plain));

export function createSyaiCloudSim(o: SyaiCloudSimOptions): SyaiCloudSim {
  const gsk = o.glucoseSecretKey ?? 'SECRETKEY0000000';
  const serverId = 'Syai Tag:i:n:11111111-2222-3333-4444-555555555555';
  const userId = 'user-1';
  const calls: string[] = [];
  const faults = { loginElsewhere: false, revokeAccessTokens: false, wrongSignatures: false };
  const logins = { count: 0 };
  const refreshes = { count: 0 };
  const sim: SyaiCloudSim = { fetch: undefined as unknown as typeof fetch, calls, logins, refreshes, faults, sensor: o.sensor };

  let channel: { secretId: string; deviceId: string; gcmKey: Bytes; hmacKey: Bytes; expireTime: number } | null = null;
  let apiToken = '';
  let refreshToken = '';
  const validAccess = new Set<string>();

  const jwt = (deviceId: string, ttlSec: number): string => {
    const header = b64url(utf8Encode('{"alg":"HS256"}'));
    const payload = b64url(utf8Encode(JSON.stringify({ sub: userId, device_id: deviceId, app_name: 'Syai Tag', exp: Math.floor(o.clock.now() / 1000) + ttlSec })));
    const token = `${header}.${payload}.${b64url(utf8Encode(String(Math.random())))}`;
    return token;
  };

  const respond = (status: number, body: unknown): Response => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, ok: status >= 200 && status < 300, text: async () => text } as unknown as Response;
  };

  const sealed = (payload: unknown): Response => {
    if (!channel) return respond(500, { code: 'NoChannel' });
    const nonce = new Uint8Array(12).fill(9);
    const box = gcm(channel.gcmKey, nonce, sessionAad(channel)).encrypt(utf8Encode(JSON.stringify(payload)));
    return respond(200, { cipherText: base64Encode(box.slice(0, box.length - 16)), cipherMac: base64Encode(box.slice(box.length - 16)), cipherNonce: base64Encode(nonce) });
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/cgm\/security\/app\/server\//, '');
    calls.push(`${method} ${path}`);
    const headers = new Map(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));

    if (path === 'security/exchangeKey') {
      const body = JSON.parse(String(init?.body)) as { clientPubKeyX: string; clientPubKeyY: string; clientTimestamp: number; clientSignature: string };
      const deviceId = headers.get('deviceid') ?? '';
      const expected = hex(sha256(utf8Encode(deviceId + body.clientPubKeyX + body.clientPubKeyY + String(body.clientTimestamp))));
      if (expected !== body.clientSignature) return respond(400, { code: 'BadSignature' });
      const sk = p256.utils.randomSecretKey();
      const pub = p256.getPublicKey(sk, false);
      const shared = p256.getSharedSecret(sk, concatBytes(new Uint8Array([4]), base64Decode(body.clientPubKeyX)!, base64Decode(body.clientPubKeyY)!), false);
      const secretId = `secret-${calls.length}`;
      const expireTime = o.clock.now() + 3_600_000;
      channel = { secretId, deviceId, expireTime, ...deriveChannelKeys(shared.slice(1, 33), secretId, deviceId, expireTime) };
      return respond(200, { code: 'OK', data: { serverPubKeyX: base64Encode(pub.slice(1, 33)), serverPubKeyY: base64Encode(pub.slice(33, 65)), secretId, expireTime } });
    }

    // Enveloped request: ciphertext in the query (GET) or the JSON body (POST/PUT).
    const ch = channel;
    if (!ch || headers.get('ciphersecretid') !== ch.secretId) return respond(400, { code: 'NoChannel' });
    const field = (name: 'Text' | 'Mac' | 'Nonce' | 'Signature'): string => {
      if (method === 'GET') return url.searchParams.get(`cipherParam${name}`) ?? '';
      return (JSON.parse(String(init?.body)) as Record<string, string>)[`cipherBody${name}`] ?? '';
    };
    const text = field('Text');
    const sigMsg = utf8Encode(`${headers.get('ciphernonceid')}${headers.get('cipherseq')}${headers.get('ciphertimenow')}${text}`);
    if (base64Encode(hmac(sha256, ch.hmacKey, sigMsg)) !== field('Signature')) return respond(400, { code: 'BadEnvelopeSignature' });
    const plain = JSON.parse(
      utf8Decode(gcm(ch.gcmKey, base64Decode(field('Nonce'))!, sessionAad(ch)).decrypt(concatBytes(base64Decode(text)!, base64Decode(field('Mac'))!))),
    ) as Record<string, unknown>;
    const deviceId = ch.deviceId;
    const id = { appName: headers.get('appname') ?? '', deviceId };
    const ts = headers.get('timestamp') ?? '';

    switch (path) {
      case 'user/apiToken': {
        if (plain.signature !== signApiToken(id, ts)) return sealed({ code: 'BadSign' });
        apiToken = `api-${calls.length}`;
        return sealed({ code: 'OK', data: apiToken });
      }
      case 'user/mail/login': {
        const info = JSON.parse(utf8Decode(ecb(utf8Encode(LOGIN_AES_KEY)).decrypt(base64Decode(String(plain.encryptInfo))!))) as { email: string; password: string };
        if (plain.apiToken !== apiToken || plain.signature !== signLogin(id, ts, apiToken, info.email, info.password)) return sealed({ code: 'BadSign' });
        if (info.email !== o.email || info.password !== o.password) return sealed({ code: 'User_InvalidParams', msg: 'bad credentials' });
        logins.count++;
        const access = jwt(deviceId, o.accessTtlSec ?? 3600);
        validAccess.add(access);
        refreshToken = jwt(deviceId, 86_400);
        return sealed({ code: 'OK', data: { userId, glucoseSecretKey: gsk, jwtToken: { accessToken: access, refreshToken } } });
      }
      case 'jwt/refreshToken': {
        if (faults.loginElsewhere) return respond(401, { code: 'AuthFailed_LoginElsewhere' });
        if (headers.get('refreshtoken') !== refreshToken) return respond(401, { code: 'AuthFailed' });
        refreshes.count++;
        const access = jwt(deviceId, o.accessTtlSec ?? 3600);
        validAccess.add(access);
        return sealed({ code: 'OK', data: { jwtToken: { accessToken: access, refreshToken } } });
      }
      case 'deviceBind/getBindDevice': {
        if (faults.revokeAccessTokens || !validAccess.has(headers.get('authorization') ?? '')) return respond(401, { code: 'AuthFailed' });
        const s = sim.sensor;
        if (!s) return sealed({ code: 'OK', data: null });
        return sealed({ code: 'OK', data: { mac: s.mac, deviceType: 'cgm', deviceVersion: s.deviceVersion ?? 'V1.7.SH22601.3', activeTime: s.activeTime, produceTime: s.produceTime, coeffUpdateTime: s.coeffUpdateTime, coefficient: wrap(s.coefficients.join(','), deriveWrapKey(gsk, s.coeffUpdateTime, s.mac)) } });
      }
      case 'device/authInfo': {
        if (!validAccess.has(headers.get('authorization') ?? '')) return respond(401, { code: 'AuthFailed' });
        const s = sim.sensor;
        if (!s || (!faults.wrongSignatures && plain.sign !== signAuthInfo(id, s.mac, ts))) return sealed({ code: 'AppDevice_BadSign' });
        const keyPlain = s.rawKeyA ? s.keyGroup : utf8Encode(hexUpper(s.keyGroup));
        return sealed({ code: 'OK', data: { mac: s.mac, keyA: wrap(keyPlain, deriveWrapKey(gsk, s.produceTime, s.mac)), produceTime: s.produceTime, activeExpireTime: s.activeExpireTimeMs ?? 14 * 86_400_000, preheatPeriodTime: s.preheatPeriodTimeMs ?? 1_800_000, serialNo: 'SN123', batchNo: 'B1' } });
      }
      default:
        return respond(404, { code: 'NotFound' });
    }
  };
  (sim as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
  return sim;
}

