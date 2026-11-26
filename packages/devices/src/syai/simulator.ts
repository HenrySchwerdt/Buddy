/**
 * Protocol simulator for a Syai Ultra sensor, for tests only. Implements the device side of the
 * documented protocol (SyaiKit, MIT, © 2026 Nightscout Foundation): the P-256 + key-group
 * handshake, AES-ECB record frames, live/history notifications and the cmd lifecycle state. No
 * Swift counterpart. A glucose of `mg/dL` is encoded as raw current `mmol * 1000`, which a
 * `linearCoefficients()` calibration decodes back exactly.
 */
import type { Bytes } from '@buddy/core';
import { concatBytes, u16le, writeU16le } from '@buddy/core';
import { ecb } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { appSignature, currentTimeDigestEncoding, keyAt, macBytes, sessionKeyFromSharedSecretX } from './ble-auth';
import { bytesEqual, utf8Encode } from './bytes';
import { CHAR, MMOL_TO_MGDL, SERVICE } from './constants';
import { HEADER_WIDTH, parseVersionForDevice, recordLength } from './frames';
import type { FakePeripheral, PeripheralLink } from '../testkit/fake-ble';

/**
 * Coefficients that make the program return `current / 1000` mmol/L at any age:
 * R0 = 1, R1 = V0, R2 = R1 / 1000, R3 = R2, R4 = 1.
 */
export const linearCoefficients = (): number[] => [0, 0, 1, 0, 0, 0.001, 0, 0, 1, 0, 1, 0, 172_800, 1];

/** Raw current that decodes to `mgdl` under `linearCoefficients()` (rounded to the sensor's 0.1 mmol/L step). */
export const currentForMgdl = (mgdl: number): number => Math.round((mgdl / MMOL_TO_MGDL) * 10) * 100;

export interface SimRecord {
  readonly current: number;
  readonly temperatureC?: number;
}

/** Builds one on-wire record (9 B for V1.7, 8 B for V1.6). */
export function encodeSimRecord(parseVersion: string, elapsedSec: number, r: SimRecord): Bytes {
  const temp = r.temperatureC ?? 32;
  if (parseVersion === 'V1.7') {
    const run = elapsedSec << 2;
    const t = Math.round(temp * 100);
    return new Uint8Array([r.current & 0xff, (r.current >> 8) & 0xff, (r.current >> 16) & 0x03, 0, run & 0xff, (run >> 8) & 0xff, (run >> 16) & 0xff, t & 0xff, (t >> 8) & 0xff]);
  }
  const packed = ((Math.round(temp * 10) << 22) | (elapsedSec & 0x3fffff)) >>> 0;
  return new Uint8Array([r.current & 0xff, (r.current >> 8) & 0xff, 0, 0, packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, (packed >>> 24) & 0xff]);
}

/** Header (crc, error, startIndex, surplus) + records, zero padded to whole AES blocks and encrypted. */
export function encryptSimFrame(sessionKey: Bytes, startIndex: number, surplus: number, records: readonly Bytes[]): Bytes {
  const body = concatBytes(new Uint8Array(4), writeU16le(startIndex), writeU16le(surplus & 0xffff), ...records);
  const padded = new Uint8Array(Math.ceil(body.length / 16) * 16);
  padded.set(body);
  return ecb(sessionKey, { disablePadding: true }).encrypt(padded);
}

export interface SyaiSimOptions {
  readonly mac: string;
  /** 96 raw bytes. */
  readonly keyGroup: Bytes;
  readonly id?: string;
  readonly firmware?: string;
  readonly cmdState?: number;
  /** Index of the newest record when the app connects. */
  readonly liveIndex: number;
  /** Record content per index; defaults to a steady 110 mg/dL under `linearCoefficients()`. */
  readonly record?: (index: number) => SimRecord;
  /** Elapsed seconds = 60 * index + offset (62 on V1.7, 60 on V1.6 by default). */
  readonly elapsedOffset?: number;
  /** Records per history packet; larger requests page with a surplus counter. Defaults to what fits 176 B. */
  readonly recordsPerPacket?: number;
  /** Device-side key index and time field of the auth challenge. */
  readonly deviceKeyIdx?: number;
  /** true: from the second history request on, the answer carries the previous answer's bodies under the new headers (the mis-serving firmware). */
  readonly replayHistory?: boolean;
  /** Maps characteristic to the only service it answers under; anything else fails like a missing characteristic. */
  readonly strictServices?: Readonly<Record<string, string>>;
  /** false: the app's auth signature is never accepted (the app does not hold the key group). */
  readonly acceptApp?: boolean;
}

export interface SyaiSimulator extends FakePeripheral {
  readonly historyRequests: readonly { readonly from: number; readonly count: number }[];
  readonly writes: readonly { readonly characteristic: string; readonly data: Bytes }[];
  readonly authenticated: boolean;
  readonly authAttempts: number;
  liveIndex: number;
  /** Emits the live record for `index` (and moves `liveIndex`). */
  pushLive(index: number): void;
  /** The sensor drops the link (radio loss). */
  drop(): void;
}

export function createSyaiSimulator(o: SyaiSimOptions): SyaiSimulator {
  const mac6 = macBytes(o.mac);
  const firmware = o.firmware ?? 'E2.0.1(V1.7.SH22537.1)';
  const parseVersion = parseVersionForDevice(firmware);
  const recLen = recordLength(parseVersion);
  const offset = o.elapsedOffset ?? (parseVersion === 'V1.7' ? 62 : 60);
  const perPacket = o.recordsPerPacket ?? Math.floor((176 - HEADER_WIDTH) / recLen);
  const recordAt = o.record ?? (() => ({ current: currentForMgdl(110) }));
  const seed = sha256(utf8Encode(`syai-sim-device-key-${o.mac}`));
  const deviceKey = p256.utils.randomSecretKey(concatBytes(seed, seed.slice(0, 16)));
  const devicePub = p256.getPublicKey(deviceKey, false);
  const idx = o.deviceKeyIdx ?? 2;
  const time = new Uint8Array([0x10, 0x00, 0x00]);
  const currentTime = new Uint8Array([0x34, 0x12, 0x00, 0x00]);
  const authDevBlob = concatBytes(new Uint8Array([idx]), time, devicePub.slice(1));
  const authSign = sha256(concatBytes(keyAt(idx, o.keyGroup), mac6, devicePub.slice(1, 33), devicePub.slice(33, 65), time));

  const historyRequests: { from: number; count: number }[] = [];
  const writes: { characteristic: string; data: Bytes }[] = [];
  let sessionKey: Bytes | null = null;
  let appHost: { idx: number; pubX: Bytes; pubY: Bytes } | null = null;
  let authAttempts = 0;
  let linkRef: PeripheralLink | null = null;
  let lastBodies: Bytes[][] = [];

  const record = (index: number) => encodeSimRecord(parseVersion, 60 * index + offset, recordAt(index));
  const checkService = (service: string, characteristic: string) => {
    const only = o.strictServices?.[characteristic];
    if (only && only.toLowerCase() !== service.toLowerCase()) throw new Error(`Characteristic ${characteristic} not found in service ${service}`);
  };
  const notifyLive = (index: number) => {
    if (!sessionKey || !linkRef) return;
    linkRef.notify(SERVICE.cgm, CHAR.newGlucose, encryptSimFrame(sessionKey, index, -1, [record(index)]));
  };

  const answerHistory = (from: number, count: number) => {
    const key = sessionKey;
    const link = linkRef;
    if (!key || !link) return;
    const packets = Math.max(1, Math.ceil(count / perPacket));
    const bodies: Bytes[][] = [];
    for (let p = 0; p < packets; p++) {
      const start = from + p * perPacket;
      const n = Math.min(perPacket, count - p * perPacket);
      // The mis-serving firmware counts the headers correctly but replays the previous bodies.
      const replay = o.replayHistory ? lastBodies[p] : undefined;
      bodies.push(replay ?? Array.from({ length: n }, (_, i) => record(start + i)));
    }
    lastBodies = bodies;
    bodies.forEach((recs, p) => link.notify(SERVICE.cgm, CHAR.glucoseRecord, encryptSimFrame(key, from + p * perPacket, packets - 1 - p, recs)));
  };

  const sim: SyaiSimulator = {
    id: o.id ?? `syai-sim-${o.mac}`,
    name: 'SYAI',
    serviceUuids: [SERVICE.cgm],
    // company id (2 B) then the MAC, as the sensor advertises it
    manufacturerData: concatBytes(new Uint8Array([0xab, 0xcd]), mac6),
    liveIndex: o.liveIndex,
    historyRequests,
    writes,
    get authenticated() {
      return sessionKey !== null;
    },
    get authAttempts() {
      return authAttempts;
    },
    onConnect(link) {
      linkRef = link;
      sessionKey = null;
      appHost = null;
    },
    onRead(service, c) {
      checkService(service, c);
      switch (c) {
        case CHAR.authDev: return authDevBlob;
        case CHAR.authFlag: return authSign;
        case CHAR.currentTime: return currentTime;
        case CHAR.softVersion: return utf8Encode(firmware);
        case CHAR.cmd: return new Uint8Array([o.cmdState ?? 3]);
        default: throw new Error(`Characteristic ${c} not readable`);
      }
    },
    onWrite(service, c, data, link) {
      checkService(service, c);
      writes.push({ characteristic: c, data });
      if (c === CHAR.authHost) {
        appHost = { idx: u16le(data, 0), pubX: data.slice(4, 36), pubY: data.slice(36, 68) };
      } else if (c === CHAR.authFlag) {
        authAttempts++;
        const host = appHost;
        const expected = host ? appSignature(keyAt(host.idx, o.keyGroup), mac6, host.pubX, host.pubY, currentTimeDigestEncoding(currentTime)) : null;
        if (!host || !expected || !bytesEqual(expected, data) || o.acceptApp === false) {
          setTimeout(() => link.disconnect(new Error('auth rejected')), 1);
          return;
        }
        const shared = p256.getSharedSecret(deviceKey, concatBytes(new Uint8Array([0x04]), host.pubX, host.pubY), false);
        sessionKey = sessionKeyFromSharedSecretX(shared.slice(1, 33));
      } else if (c === CHAR.requestByCount) {
        const from = u16le(data, 0);
        const count = u16le(data, 2);
        historyRequests.push({ from, count });
        answerHistory(from, count);
      }
    },
    onSubscribe(service, c, link) {
      checkService(service, c);
      if (c === CHAR.errorInfo) link.notify(SERVICE.cgm, CHAR.errorInfo, new Uint8Array([0x07, 0x77, 0x86, 0x01]));
      if (c === CHAR.newGlucose) notifyLive(sim.liveIndex);
    },
    pushLive(index) {
      sim.liveIndex = index;
      notifyLive(index);
    },
    drop() {
      linkRef?.disconnect(new Error('radio loss'));
    },
  };
  return sim;
}
