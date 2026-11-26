/**
 * Pod discovery. Port of `Bluetooth/PodAdvertisement.swift` (DASH part) from OmnipodKit
 * (MIT License, (c) LoopKit Authors): a DASH pod advertises nine 16-bit service UUIDs that encode
 * its id, lot and sequence number; a pod that is not paired yet advertises 0xFFFF 0xFFFE as id.
 */
import type { BleAdvertisement, BleTransport } from '@buddy/core';
import { DASH_ADVERTISEMENT_UUID } from './constants';
import { OmnipodError } from './errors';

const BASE_UUID = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i;

/** 16-bit UUID in upper case from either the short or the 128-bit base form. */
export function shortUuid(uuid: string): string {
  const m = BASE_UUID.exec(uuid);
  if (m) return m[1]!.toUpperCase();
  return uuid.toUpperCase();
}

export interface PodAdvertisement {
  readonly id: string;
  readonly pairable: boolean;
  /** advertised pod id (0xFFFFFFFE while unpaired) */
  readonly podId: number;
  readonly rssi: number | null;
}

export function parseAdvertisement(ad: BleAdvertisement): PodAdvertisement | null {
  const u = ad.serviceUuids.map(shortUuid);
  if (u.length !== 9 || u[0] !== '4024' || u[2] !== '000A') return null;
  const podId = Number.parseInt(u[3]! + u[4]!, 16);
  if (!Number.isFinite(podId)) return null;
  return { id: ad.id, pairable: u[3] === 'FFFF' && u[4] === 'FFFE', podId: podId >>> 0, rssi: ad.rssi };
}

/** Scans for pairable pods; exactly one must be in range (a second one could be someone else's). */
export async function findPairablePod(ble: BleTransport, scanTimeoutMs: number): Promise<PodAdvertisement> {
  const found = new Map<string, PodAdvertisement>();
  await ble.scan({ services: [DASH_ADVERTISEMENT_UUID], timeoutMs: scanTimeoutMs }, (ad) => {
    const p = parseAdvertisement(ad);
    if (p?.pairable) found.set(p.id, p);
  });
  if (found.size === 0) throw new OmnipodError('pairing', 'No pairable pod found. Is the pod filled (with water, bench only) and nearby?');
  if (found.size > 1) throw new OmnipodError('pairing', 'More than one pairable pod found. Move away from other pods and try again.');
  return [...found.values()][0]!;
}

/** Advertisement service UUIDs a pod would send (used by the simulator). */
export function advertisementUuids(podId: number, lot: number, seq: number): string[] {
  const short = (s: string): string => `0000${s.toLowerCase()}-0000-1000-8000-00805f9b34fb`;
  const idHex = podId.toString(16).padStart(8, '0');
  const lotHex = lot.toString(16).padStart(10, '0');
  const seqHex = seq.toString(16).padStart(6, '0');
  const tail = lotHex + seqHex; // 16 hex chars -> 4 UUIDs of 4 hex chars... lot spans 10, seq 6
  return [
    '4024',
    '2a00',
    '000a',
    idHex.slice(0, 4),
    idHex.slice(4),
    tail.slice(0, 4),
    tail.slice(4, 8),
    tail.slice(8, 12),
    tail.slice(12, 16),
  ].map(short);
}
