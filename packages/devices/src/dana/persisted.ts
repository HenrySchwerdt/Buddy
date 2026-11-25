/**
 * Persistence of the DanaKit pump-manager state that must survive app restarts (pairing keys,
 * BLE identifier, history cursor). Replaces the `rawState` dictionary of
 * DanaKit/PumpManager/DanaKitPumpManagerState.swift from loopandlearn/DanaKit
 * (MIT, © 2021 Randall Knutson and the DanaKit authors) with a keychain-backed `SecretStore`.
 */
import { fromHex, hex, type Bytes, type Logger, type SecretStore } from '@buddy/core';
import type { BolusFingerprint } from './bolus-tracker';

export interface DanaPersisted {
  /** BLE peripheral identifier of the paired pump (`bleIdentifier`). */
  readonly bleId?: string;
  /** RSv3 pairing key (6 bytes) and random pairing key (3 bytes), hex. */
  readonly pairingKey?: string;
  readonly randomPairingKey?: string;
  /** BLE5 key (6 ASCII digits), hex. */
  readonly ble5Keys?: string;
  /** Pump-clock time from which the next history upload starts (`lastStatusPumpDateTime`). */
  readonly historyFrom?: number;
  /** Boluses this driver started, so their pump history records are never imported again. */
  readonly fingerprints?: readonly BolusFingerprint[];
}

export const secretKey = (deviceName: string): string => `dana-i:${deviceName.toUpperCase()}`;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseFingerprints(v: unknown): BolusFingerprint[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: unknown) => {
    if (typeof x !== 'object' || x === null) return [];
    const f = x as Record<string, unknown>;
    if (typeof f.id !== 'string' || !num(f.start) || !num(f.end) || !num(f.requested)) return [];
    return [{ id: f.id, start: f.start, end: f.end, requested: f.requested, ...(typeof f.recordId === 'string' ? { recordId: f.recordId } : {}) }];
  });
}

const isHex = (v: unknown, bytes: number): v is string => typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/i.test(v);

/** Validates everything read back from storage (never trust stored data blindly). */
export function parsePersisted(raw: string | null): DanaPersisted {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof v !== 'object' || v === null) return {};
  const o = v as Record<string, unknown>;
  return {
    ...(typeof o.bleId === 'string' && o.bleId.length > 0 ? { bleId: o.bleId } : {}),
    ...(isHex(o.pairingKey, 6) && isHex(o.randomPairingKey, 3) ? { pairingKey: o.pairingKey, randomPairingKey: o.randomPairingKey } : {}),
    ...(isHex(o.ble5Keys, 6) ? { ble5Keys: o.ble5Keys } : {}),
    ...(num(o.historyFrom) ? { historyFrom: o.historyFrom } : {}),
    ...(Array.isArray(o.fingerprints) ? { fingerprints: parseFingerprints(o.fingerprints) } : {}),
  };
}

export const bytesOrEmpty = (h: string | undefined): Bytes => (h ? fromHex(h) : new Uint8Array(0));
export const hexOrUndefined = (b: Bytes): string | undefined => (b.length > 0 ? hex(b) : undefined);

export class DanaStore {
  private cache: DanaPersisted | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly key: string,
    private readonly log: Logger,
  ) {}

  async load(): Promise<DanaPersisted> {
    if (!this.cache) this.cache = parsePersisted(await this.secrets.get(this.key));
    return this.cache;
  }

  async update(patch: Partial<DanaPersisted>): Promise<void> {
    await this.load();
    // Read the cache after the await so concurrent updates never overwrite each other
    const next: DanaPersisted = { ...this.cache, ...patch };
    this.cache = next;
    try {
      await this.secrets.set(this.key, JSON.stringify(next));
    } catch (e) {
      this.log.error(`Dana: could not persist pump state: ${String(e)}`);
    }
  }

  /** Read-modify-write against the current state (no lost updates between concurrent writers). */
  async modify(fn: (current: DanaPersisted) => Partial<DanaPersisted>): Promise<void> {
    await this.load();
    await this.update(fn(this.cache ?? {}));
  }

  async clear(): Promise<void> {
    this.cache = {};
    await this.secrets.set(this.key, null);
  }
}
