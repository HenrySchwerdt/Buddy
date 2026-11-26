/**
 * Protocol simulator for the Libre 3: a `FakePeripheral` (see `testkit/fake-ble.ts`) that speaks the
 * command-gated authorization (full and cached), the Phase 5/6 exchange and the encrypted data plane
 * (realtime, patch status, historical / clinical backfill). For unit tests only.
 *
 * It signs its sensor certificate with a throwaway test key (`signingPublicKey`), which tests pass as
 * `signingKeys`; no Abbott key material is used or needed. Wire formats follow RoundWhiteDiscKit
 * `protocol.md` and the sources of the port (MIT, (c) the RoundWhiteDiscKit authors).
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ccmDecrypt, ccmEncrypt } from './ccm';
import { LIBRE3_CHAR, LIBRE3_DATA_SERVICE, LIBRE3_SECURITY_SERVICE, PHASE5_WIRE_SIZE, SEC_CMD, SEC_RESPONSE } from './constants';
import { DataPlaneCrypto } from './data-plane';
import { parseDataFrame, reassembleWrites } from './framing';
import { advertisedNameForAddress } from './nfc';
import type { FakePeripheral, PeripheralLink } from '../testkit/fake-ble';

type Rng = (n: number) => Bytes;

export interface RealtimeSpec {
  /** Current glucose (raw sensor value) or null for a warmup frame. */
  readonly mgdl: number | null;
  readonly trend?: number;
  readonly actionable?: boolean;
  /** Bit 15 data-quality error word (e.g. 0xa000 sensor too hot). */
  readonly dqError?: number;
  readonly sensorCondition?: number;
  readonly rate?: number;
}

export interface PatchStatusSpec {
  readonly errorData?: number;
  readonly patchState?: number;
}

export interface SimulatorOptions {
  readonly bleAddress?: string;
  readonly blePin?: Bytes;
  readonly lifeCount?: number;
  readonly random?: Rng;
}

const u16 = (v: number): Bytes => Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
const seeded = (seed: number): Rng => {
  let s = seed >>> 0;
  return (n) => Uint8Array.from({ length: n }, () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24) & 0xff);
};

export class Libre3SensorSimulator {
  readonly bleAddress: string;
  readonly blePin: Bytes;
  /** Test signing key standing in for the Abbott patch-signing key. */
  readonly signingPublicKey: Bytes;
  lifeCount: number;
  /** What the sensor remembers from a full handshake (cached reconnect path). */
  authKey: Bytes | null = null;
  readonly commands: { stream: 'historical' | 'clinical'; fromLifeCount: number }[] = [];
  readonly connections: { full: boolean; accepted: boolean }[] = [];
  /** Raw 5-minute historical values by life count / per-minute clinical values by life count. */
  readonly history = new Map<number, number>();
  readonly clinical = new Map<number, number>();
  failBackfillWrites = 0;
  rejectAuthorization = false;
  /** Decides whether the sensor accepts a phone certificate (default: any well-formed one). */
  acceptCertificate: (certificate: Bytes) => boolean = () => true;

  private readonly rng: Rng;
  private readonly staticPrivate: Bytes;
  private readonly certificate: Bytes;
  private link: PeripheralLink | null = null;
  private crypto: DataPlaneCrypto | null = null;
  private certWrites: Bytes[] = [];
  private challengeWrites: Bytes[] = [];
  private full = false;
  private phoneCertificate: Bytes | null = null;
  private phoneEphemeral: Bytes | null = null;
  private sensorEphemeralPrivate: Bytes | null = null;
  private pendingKey: Bytes | null = null;
  private r1: Bytes = new Uint8Array(16);
  private nonce7: Bytes = new Uint8Array(7);
  private readonly sequence = { glucose: 0, status: 0, historic: 0, clinical: 0 };
  private latestStatus: PatchStatusSpec = { errorData: 0, patchState: 4 };
  readonly peripheral: FakePeripheral;

  constructor(options: SimulatorOptions = {}) {
    this.rng = options.random ?? seeded(0x1b3);
    this.bleAddress = options.bleAddress ?? 'CC:22:DF:B8:F9:58';
    this.blePin = options.blePin ?? Uint8Array.of(0x32, 0x25, 0xec, 0x72);
    this.lifeCount = options.lifeCount ?? 120;
    const signingPrivate = p256.utils.randomSecretKey(this.rng(48));
    this.signingPublicKey = p256.getPublicKey(signingPrivate, false);
    this.staticPrivate = p256.utils.randomSecretKey(this.rng(48));
    const header = concatBytes(Uint8Array.of(0x01), this.rng(10));
    const body = concatBytes(header, p256.getPublicKey(this.staticPrivate, false));
    this.certificate = concatBytes(body, p256.sign(body, signingPrivate, { lowS: false }));
    this.peripheral = {
      id: 'libre3-sim',
      name: advertisedNameForAddress(this.bleAddress),
      serviceUuids: [LIBRE3_DATA_SERVICE],
      onConnect: (link) => this.onConnect(link),
      onWrite: (service, characteristic, data) => this.onWrite(service, characteristic, data),
      onRead: (_service, characteristic) => {
        if (characteristic !== LIBRE3_CHAR.patchStatus || !this.crypto) throw new Error('Not readable');
        return this.patchStatusFrame();
      },
    };
  }

  // ── connection / security ───────────────────────────────────────────────────

  private onConnect(link: PeripheralLink): void {
    this.link = link;
    this.crypto = null;
    this.full = false;
    this.certWrites = [];
    this.challengeWrites = [];
  }

  /** Drops the link the way a sensor going out of range does. */
  drop(error = new Error('Sensor out of range')): void {
    this.link?.disconnect(error);
    this.link = null;
    this.crypto = null;
  }

  private notifySecurity(characteristic: string, message: Bytes): void {
    // sensor to phone: `sequence1 || payload_chunk`, 19 payload bytes per notification
    for (let i = 0, seq = 0; i < message.length; i += 19, seq++) {
      this.link?.notify(LIBRE3_SECURITY_SERVICE, characteristic, concatBytes(Uint8Array.of(seq), message.subarray(i, i + 19)));
    }
  }

  private respond(code: number): void {
    this.link?.notify(LIBRE3_SECURITY_SERVICE, LIBRE3_CHAR.commandResponse, Uint8Array.of(code));
  }

  private onWrite(service: string, characteristic: string, data: Bytes): void {
    if (characteristic === LIBRE3_CHAR.certData) this.certWrites.push(data);
    else if (characteristic === LIBRE3_CHAR.challengeData) this.challengeWrites.push(data);
    else if (characteristic === LIBRE3_CHAR.commandResponse) this.onCommand(data[0]!);
    else if (service === LIBRE3_DATA_SERVICE && characteristic === LIBRE3_CHAR.patchControl) this.onPatchControl(data);
  }

  private takeWrites(kind: 'cert' | 'challenge'): Bytes {
    const fragments = kind === 'cert' ? this.certWrites : this.challengeWrites;
    if (kind === 'cert') this.certWrites = [];
    else this.challengeWrites = [];
    return reassembleWrites(fragments);
  }

  private reject(reason: string): void {
    this.connections[this.connections.length - 1]!.accepted = false;
    this.link?.disconnect(new Error(`Sensor rejected the phone: ${reason}`));
  }

  private onCommand(command: number): void {
    switch (command) {
      case SEC_CMD.startAuthentication:
        this.full = true;
        this.connections.push({ full: true, accepted: false });
        break;
      case SEC_CMD.certificateLoadDone:
        this.phoneCertificate = this.takeWrites('cert');
        if (this.rejectAuthorization || this.phoneCertificate.length !== 162 || this.phoneCertificate[33] !== 0x04 || !this.acceptCertificate(this.phoneCertificate)) return this.reject('certificate');
        this.respond(SEC_RESPONSE.certificateAccepted);
        break;
      case SEC_CMD.getCertificate:
        this.respond(SEC_RESPONSE.certificateReady);
        this.notifySecurity(LIBRE3_CHAR.certData, this.certificate);
        break;
      case SEC_CMD.ephemeralDone: {
        this.phoneEphemeral = this.takeWrites('cert').slice(0, 65);
        this.sensorEphemeralPrivate = p256.utils.randomSecretKey(this.rng(48));
        this.respond(SEC_RESPONSE.ephemeralReady);
        this.notifySecurity(LIBRE3_CHAR.certData, p256.getPublicKey(this.sensorEphemeralPrivate, false));
        break;
      }
      case SEC_CMD.startAuthorization:
        this.startAuthorization();
        break;
      case SEC_CMD.challengeLoadDone:
        this.finishAuthorization();
        break;
      default:
        break; // loadCertificate and validateCertificate need no reply
    }
  }

  private startAuthorization(): void {
    if (!this.full) {
      this.connections.push({ full: false, accepted: false });
      if (!this.authKey || this.rejectAuthorization) return this.reject('no cached authorization');
      this.pendingKey = this.authKey;
    } else {
      const ze = p256.getSharedSecret(this.sensorEphemeralPrivate!, this.phoneEphemeral!, true).slice(1);
      const zs = p256.getSharedSecret(this.staticPrivate, this.phoneCertificate!.slice(33, 98), true).slice(1);
      this.pendingKey = sha256(concatBytes(Uint8Array.of(0, 0, 0, 1), ze, zs)).slice(0, 16);
    }
    this.r1 = this.rng(16);
    this.nonce7 = this.rng(7);
    this.respond(SEC_RESPONSE.challengeLoadDone);
    this.notifySecurity(LIBRE3_CHAR.challengeData, concatBytes(this.r1, this.nonce7));
  }

  private finishAuthorization(): void {
    const wire = this.takeWrites('challenge');
    const key = this.pendingKey;
    if (!key || wire.length !== PHASE5_WIRE_SIZE) return this.reject('phase 5 size');
    let plaintext: Bytes;
    try {
      plaintext = ccmDecrypt(key, this.nonce7, wire.subarray(0, 36), wire.subarray(36, 40));
    } catch {
      return this.reject('phase 5 tag');
    }
    const [echoedR1, r2, tail] = [plaintext.subarray(0, 16), plaintext.subarray(16, 32), plaintext.subarray(32, 36)];
    if (echoedR1.some((b, i) => b !== this.r1[i]) || tail.some((b, i) => b !== this.blePin[i])) return this.reject('challenge or PIN');
    const kEnc = this.rng(16);
    const ivEnc = this.rng(8);
    const nonce = this.rng(7);
    const sealed = ccmEncrypt(key, nonce, concatBytes(r2, this.r1, kEnc, ivEnc), 4);
    this.authKey = key;
    this.crypto = new DataPlaneCrypto(kEnc, ivEnc);
    this.connections[this.connections.length - 1]!.accepted = true;
    this.respond(SEC_RESPONSE.challengeLoadDone);
    this.notifySecurity(LIBRE3_CHAR.challengeData, concatBytes(sealed.ciphertext, sealed.tag, nonce));
  }

  // ── data plane ──────────────────────────────────────────────────────────────

  private notifyData(characteristic: string, frame: Bytes): void {
    this.link?.notify(LIBRE3_DATA_SERVICE, characteristic, frame);
  }

  /** Pushes one realtime frame (15-byte prefix + suffix, like the sensor); does not advance the life count. */
  emitRealtime(spec: RealtimeSpec): void {
    const crypto = this.requireCrypto();
    const raw = spec.mgdl ?? 0;
    const word = (raw & 0x1fff) | ((spec.sensorCondition ?? 0) << 13) | (spec.dqError ?? 0);
    const histLc = this.lifeCount - ((this.lifeCount - 2) % 5) - 15;
    const p = new Uint8Array(29);
    p.set(u16(this.lifeCount), 0);
    p.set(u16(word), 2);
    p.set(u16((spec.rate ?? -42) & 0xffff), 4);
    p.set(u16(raw * 100), 8);
    p.set(u16(Math.max(0, histLc)), 10);
    p.set(u16(raw), 12);
    p[14] = (spec.trend ?? 3) | ((spec.actionable ?? true) ? 0x08 : 0);
    p.set(u16(raw), 15);
    p.set(u16(raw), 17);
    p.set(u16(2590), 19);
    const frame = crypto.encrypt(p, ++this.sequence.glucose, 3);
    this.notifyData(LIBRE3_CHAR.glucoseData, frame.slice(0, 15));
    this.notifyData(LIBRE3_CHAR.glucoseData, frame.slice(15));
  }

  /** Advances the sensor clock by one minute and emits a frame. */
  tick(spec: RealtimeSpec): void {
    this.lifeCount++;
    this.emitRealtime(spec);
  }

  private patchStatusFrame(): Bytes {
    const status = this.latestStatus;
    const p = concatBytes(u16(this.lifeCount - 1000), u16(status.errorData ?? 0), u16(0xe0), Uint8Array.of(0x07, status.patchState ?? 4), u16(this.lifeCount), Uint8Array.of(22, 7));
    return this.requireCrypto().encrypt(p, ++this.sequence.status, 2);
  }

  emitPatchStatus(spec: PatchStatusSpec = {}): void {
    this.latestStatus = { ...this.latestStatus, ...spec };
    this.notifyData(LIBRE3_CHAR.patchStatus, this.patchStatusFrame());
  }

  private requireCrypto(): DataPlaneCrypto {
    if (!this.crypto) throw new Error('Simulator: no authorized session');
    return this.crypto;
  }

  private onPatchControl(data: Bytes): void {
    const crypto = this.requireCrypto();
    if (this.failBackfillWrites > 0) {
      this.failBackfillWrites--;
      throw new Error('ATT error 0xFD (injected)');
    }
    const command = crypto.decrypt(parseDataFrame(data), 0);
    if (command[0] !== 0x01) return;
    const stream = command[1] === 0 ? 'historical' : 'clinical';
    const fromLifeCount = command[3]! | (command[4]! << 8);
    this.commands.push({ stream, fromLifeCount });
    if (stream === 'historical') this.streamHistorical(fromLifeCount);
    else this.streamClinical(fromLifeCount);
  }

  private streamHistorical(from: number): void {
    const crypto = this.requireCrypto();
    const grid = [...this.history.keys()].filter((lc) => lc >= from).sort((a, b) => a - b);
    for (let i = 0; i < grid.length; i += 6) {
      const start = grid[i]!;
      const values = Array.from({ length: 6 }, (_, k) => this.history.get(start + k * 5) ?? 0);
      this.notifyData(LIBRE3_CHAR.historicData, crypto.encrypt(concatBytes(u16(start), ...values.map(u16)), ++this.sequence.historic, 4));
    }
  }

  private streamClinical(from: number): void {
    const crypto = this.requireCrypto();
    for (const lc of [...this.clinical.keys()].filter((k) => k >= from).sort((a, b) => a - b)) {
      const value = this.clinical.get(lc)!;
      const record = concatBytes(u16(lc), u16(500), u16(500), u16(0x0e00), u16(0), u16(value), u16(value));
      this.notifyData(LIBRE3_CHAR.clinicalData, crypto.encrypt(record, ++this.sequence.clinical, 5));
    }
  }
}

