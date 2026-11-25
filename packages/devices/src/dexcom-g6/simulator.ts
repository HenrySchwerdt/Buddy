/**
 * Protocol simulator for a Dexcom G6 transmitter (transmitter side), for tests only.
 * Byte layouts follow the parsers ported from loopandlearn/CGMBLEKit; this file has no
 * Swift counterpart.
 */
import { concatBytes, writeU16le, writeU32le, type Bytes } from '@buddy/core';
import type { FakePeripheral, PeripheralLink } from '../testkit/fake-ble';
import { computeHash } from './auth';
import { ADVERTISEMENT_SERVICE, CGM_CHARACTERISTIC, CGM_SERVICE } from './ble-common';
import { appendingCrc, crc16, Opcode, parseAuthChallengeRx } from './messages';

export interface SimGlucose {
  /** Seconds since activation. */
  readonly timestamp: number;
  readonly glucose: number;
  readonly state?: number;
  /** Raw ×10 mg/dL/min. */
  readonly trend?: number;
  readonly displayOnly?: boolean;
}

const i8 = (v: number) => v & 0xff;

export const encodeGlucoseSub = (g: SimGlucose): Bytes =>
  concatBytes(writeU32le(g.timestamp), writeU16le((g.glucose & 0xfff) | (g.displayOnly ? 0x1000 : 0)), new Uint8Array([g.state ?? 6, i8(g.trend ?? 0)]));

export const encodeGlucoseRx = (g: SimGlucose, opts: { opcode?: number; sequence?: number; status?: number } = {}): Bytes =>
  appendingCrc(concatBytes(new Uint8Array([opts.opcode ?? Opcode.glucoseRx, opts.status ?? 0]), writeU32le(opts.sequence ?? 1), encodeGlucoseSub(g)));

export const encodeTimeRx = (currentTime: number, sessionStartTime: number): Bytes =>
  appendingCrc(concatBytes(new Uint8Array([Opcode.transmitterTimeRx, 0]), writeU32le(currentTime), writeU32le(sessionStartTime), new Uint8Array([1, 0, 0, 0])));

export const encodeVersionRx = (expiryDays: number): Bytes =>
  appendingCrc(
    concatBytes(new Uint8Array([Opcode.transmitterVersionRx, 0, 1, 0, 0, 17, 0xdf, 0x29, 0, 0, 0x51, 0, 3]), writeU16le(expiryDays), new Uint8Array([0xf0, 0])),
  );

/** Splits backfill records into 20-byte frames and builds the matching GlucoseBackfillRx. */
export function encodeBackfill(records: readonly SimGlucose[], identifier: number): { frames: Bytes[]; rx: Bytes } {
  const payload = concatBytes(new Uint8Array([0xbc, 0x46, 0, 0]), ...records.map(encodeGlucoseSub));
  const frames: Bytes[] = [];
  for (let o = 0, i = 1; o < payload.length; o += 18, i++) frames.push(concatBytes(new Uint8Array([i, identifier]), payload.subarray(o, o + 18)));
  const all = concatBytes(...frames);
  const first = records[0]?.timestamp ?? 0;
  const last = records[records.length - 1]?.timestamp ?? 0;
  const rx = appendingCrc(
    concatBytes(new Uint8Array([Opcode.glucoseBackfillRx, 0, 1, identifier]), writeU32le(first), writeU32le(last), writeU32le(all.length), writeU16le(crc16(all))),
  );
  return { frames, rx };
}

export interface G6SimulatorOptions {
  readonly transmitterId: string;
  readonly deviceId?: string;
  /** Seconds since activation "now". */
  readonly currentTime: number;
  readonly sessionStartTime: number;
  readonly glucose: SimGlucose;
  /** Passive: play the Dexcom app's session (auth seen, time, glucose, backfill). */
  readonly mode: 'active' | 'passive';
  readonly bonded?: boolean;
  readonly backfill?: readonly SimGlucose[];
  readonly expiryDays?: number;
}

export interface G6Simulator extends FakePeripheral {
  readonly authenticated: boolean;
  readonly controlWrites: readonly number[];
}

export function createG6Simulator(o: G6SimulatorOptions): G6Simulator {
  let pendingAuthRead: Bytes | null = null;
  let authenticated = false;
  let expectedChallengeHash: Bytes | null = null;
  const controlWrites: number[] = [];
  const challenge = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
  const bonded = o.bonded ?? true;
  const ctl = CGM_CHARACTERISTIC.control;

  const sim: G6Simulator = {
    id: o.deviceId ?? `g6-${o.transmitterId}`,
    name: `Dexcom${o.transmitterId.slice(-2)}`,
    serviceUuids: [ADVERTISEMENT_SERVICE, CGM_SERVICE],
    get authenticated() {
      return authenticated;
    },
    controlWrites,
    onRead(_s, c) {
      if (c.toLowerCase() !== CGM_CHARACTERISTIC.authentication || !pendingAuthRead) throw new Error('Nothing to read');
      return pendingAuthRead;
    },
    onWrite(_s, c, data, link) {
      const ch = c.toLowerCase();
      if (ch === CGM_CHARACTERISTIC.authentication) return handleAuthWrite(data);
      if (ch === ctl) return handleControlWrite(data, link);
    },
    onSubscribe(_s, c, link) {
      if (o.mode !== 'passive') return;
      const ch = c.toLowerCase();
      // The Dexcom app authenticates; we only see the final status indication.
      if (ch === CGM_CHARACTERISTIC.authentication) link.notify(CGM_SERVICE, ch, new Uint8Array([Opcode.authChallengeRx, 1, 1]));
      if (ch === ctl) {
        link.notify(CGM_SERVICE, ctl, encodeTimeRx(o.currentTime, o.sessionStartTime));
        link.notify(CGM_SERVICE, ctl, encodeGlucoseRx(o.glucose, { opcode: Opcode.glucoseG6Rx }));
      }
      if (ch === CGM_CHARACTERISTIC.backfill && o.backfill?.length) {
        const { frames, rx } = encodeBackfill(o.backfill, 0xc0);
        for (const f of frames) link.notify(CGM_SERVICE, ch, f);
        link.notify(CGM_SERVICE, ctl, rx);
      }
    },
  };

  function handleAuthWrite(data: Bytes): void {
    if (data[0] === Opcode.authRequestTx) {
      const token = data.slice(1, 9);
      const tokenHash = computeHash(o.transmitterId, token)!;
      expectedChallengeHash = computeHash(o.transmitterId, challenge);
      pendingAuthRead = concatBytes(new Uint8Array([Opcode.authRequestRx]), tokenHash, challenge);
    } else if (data[0] === Opcode.authChallengeTx) {
      const ok = expectedChallengeHash !== null && data.slice(1).every((b, i) => b === expectedChallengeHash![i]);
      authenticated = ok;
      pendingAuthRead = new Uint8Array([Opcode.authChallengeRx, ok ? 1 : 0, bonded ? 1 : 0]);
      if (!parseAuthChallengeRx(pendingAuthRead)) throw new Error('bad sim');
    }
  }

  function handleControlWrite(data: Bytes, link: PeripheralLink): void {
    const opcode = data[0]!;
    controlWrites.push(opcode);
    // An unauthenticated central gets no answers in active mode.
    if (o.mode === 'active' && !authenticated) return;
    const reply = (b: Bytes) => link.notify(CGM_SERVICE, ctl, b);
    switch (opcode) {
      case Opcode.transmitterTimeTx:
        return reply(encodeTimeRx(o.currentTime, o.sessionStartTime));
      case Opcode.glucoseTx:
        return reply(encodeGlucoseRx(o.glucose));
      case Opcode.calibrationDataTx:
        return reply(appendingCrc(concatBytes(new Uint8Array([Opcode.calibrationDataRx, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), writeU16le(0), writeU32le(0))));
      case Opcode.transmitterVersionTx:
        return reply(encodeVersionRx(o.expiryDays ?? 90));
      case Opcode.disconnectTx:
        return link.disconnect();
    }
  }

  return sim;
}
