/**
 * Protocol simulator for a Dexcom G7 sensor while the official app talks to it, for tests
 * only. Byte layouts follow the parsers ported from loopandlearn/G7SensorKit; no Swift counterpart.
 */
import { concatBytes, fromHex, writeU16le, writeU32le, type Bytes } from '@buddy/core';
import { ADVERTISEMENT_SERVICE, CGM_CHARACTERISTIC, CGM_SERVICE } from '../dexcom-g6/ble-common';
import type { FakePeripheral, PeripheralLink } from '../testkit/fake-ble';
import { AlgorithmState, G7Opcode } from './messages';

export interface SimG7Glucose {
  /** Seconds since pairing when the message is sent. */
  readonly messageTimestamp: number;
  readonly age?: number;
  readonly glucose: number | null;
  readonly state?: number;
  /** mg/dL/min, null = 0x7f. */
  readonly trend?: number | null;
  readonly sequence?: number;
  readonly displayOnly?: boolean;
}

const trendByte = (t: number | null | undefined) => (t === null || t === undefined ? 0x7f : Math.round(t * 10) & 0xff);

export const encodeG7Glucose = (g: SimG7Glucose): Bytes =>
  concatBytes(
    new Uint8Array([G7Opcode.glucoseTx, 0x00]),
    writeU32le(g.messageTimestamp),
    writeU16le(g.sequence ?? 1),
    new Uint8Array([0x00, 0x01]),
    writeU16le(g.age ?? 0),
    writeU16le(g.glucose ?? 0xffff),
    new Uint8Array([g.state ?? AlgorithmState.ok, trendByte(g.trend)]),
    writeU16le(0xffff),
    new Uint8Array([g.displayOnly ? 0x1f : 0x0f]),
  );

export const encodeG7Backfill = (b: { timestamp: number; glucose: number; state?: number; trend?: number | null }): Bytes =>
  concatBytes(
    new Uint8Array([b.timestamp & 0xff, (b.timestamp >> 8) & 0xff, (b.timestamp >> 16) & 0xff, 0]),
    writeU16le(b.glucose),
    new Uint8Array([b.state ?? AlgorithmState.ok, 0x0f, trendByte(b.trend)]),
  );

export interface G7SimulatorOptions {
  readonly name?: string;
  readonly deviceId?: string;
  readonly glucose: SimG7Glucose;
  readonly backfill?: readonly { timestamp: number; glucose: number; state?: number; trend?: number | null }[];
  /** false: the app never authenticates and the sensor drops the link (suspected session end). */
  readonly authenticates?: boolean;
  readonly extendedVersionHex?: string;
}

export interface G7Simulator extends FakePeripheral {
  readonly versionRequests: number;
}

export function createG7Simulator(o: G7SimulatorOptions): G7Simulator {
  const ctl = CGM_CHARACTERISTIC.control;
  let versionRequests = 0;
  const sim: G7Simulator = {
    id: o.deviceId ?? 'g7-sim',
    name: o.name ?? 'DXCM1A',
    serviceUuids: [ADVERTISEMENT_SERVICE, CGM_SERVICE],
    get versionRequests() {
      return versionRequests;
    },
    onWrite(_s, c, data, link) {
      if (c.toLowerCase() === ctl && data[0] === G7Opcode.extendedVersionTx) {
        versionRequests++;
        link.notify(CGM_SERVICE, ctl, fromHex(o.extendedVersionHex ?? '5200c0d70d00540600020404ff0c00'));
      }
    },
    onSubscribe(_s, c, link: PeripheralLink) {
      const ch = c.toLowerCase();
      if (ch === CGM_CHARACTERISTIC.authentication) {
        if (o.authenticates === false) {
          setTimeout(() => link.disconnect(new Error('Peripheral disconnected')), 5);
          return;
        }
        link.notify(CGM_SERVICE, ch, new Uint8Array([0x05, 0x01, 0x01]));
      }
      if (ch === ctl) link.notify(CGM_SERVICE, ctl, encodeG7Glucose(o.glucose));
      if (ch === CGM_CHARACTERISTIC.backfill && o.backfill?.length) {
        for (const b of o.backfill) link.notify(CGM_SERVICE, ch, encodeG7Backfill(b));
        link.notify(CGM_SERVICE, ctl, new Uint8Array([G7Opcode.backfillFinished, 0x00]));
      }
    },
  };
  return sim;
}
