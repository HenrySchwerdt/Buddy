/**
 * Persistence helpers for the Eros message nonce state (`NonceState.swift`, OmnipodKit, MIT
 * License, (c) LoopKit Authors). The table is derived from the pod's lot, tid and the resync
 * seed: it is stored with the pod record but never logged.
 */
import type { NonceState } from '../eros';

const isU32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/** Validates stored JSON; anything malformed means "no nonce state yet" (the next command resyncs). */
export function parseNonceState(v: unknown): NonceState | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { table?: unknown; idx?: unknown };
  if (!Array.isArray(o.table) || o.table.length !== 18 || !o.table.every(isU32)) return null;
  if (typeof o.idx !== 'number' || !Number.isInteger(o.idx) || o.idx < 0 || o.idx > 15) return null;
  return { table: o.table as number[], idx: o.idx };
}

/** Read/write access of the comms layer to the nonce state held by the driver record. */
export interface NonceHolder {
  get(): NonceState | null;
  set(state: NonceState): void;
}
