/**
 * TypeScript port of `Eros/NonceState.swift` (OmnipodKit, MIT License, (c) LoopKit Authors):
 * the Eros 32-bit message nonce generator, seeded from the pod's lot and tid. Immutable: every
 * operation returns a new state.
 */
import { CRC16_TABLE } from './crc16';

export interface NonceState {
  /** 2 LFSR words followed by 16 nonce slots. */
  readonly table: readonly number[];
  readonly idx: number;
}

const u32 = (n: number) => n >>> 0;

/** One generator step; returns the new LFSR words and the produced entry. */
function generateEntry(t0: number, t1: number): { t0: number; t1: number; entry: number } {
  const n0 = u32((t0 >>> 16) + (t0 & 0xffff) * 0x5d7f);
  const n1 = u32((t1 >>> 16) + (t1 & 0xffff) * 0x8ca0);
  return { t0: n0, t1: n1, entry: u32(n1 + (n0 & 0xffff) * 0x10000) };
}

export function createNonceState(lot: number, tid: number, seed = 0): NonceState {
  let t0 = u32((lot & 0xffff) + (lot >>> 16) + 0x55543dc3) + (seed & 0x00ff);
  let t1 = u32((tid & 0xffff) + (tid >>> 16) + 0xaaaae44e) + ((seed & 0xff00) >> 8);
  t0 = u32(t0);
  t1 = u32(t1);
  const slots: number[] = [];
  for (let i = 0; i < 16; i++) {
    const g = generateEntry(t0, t1);
    t0 = g.t0;
    t1 = g.t1;
    slots.push(g.entry);
  }
  return { table: [t0, t1, ...slots], idx: u32(t0 + t1) & 0x0f };
}

export const currentNonce = (s: NonceState): number => s.table[2 + s.idx]!;

/** The state after the current nonce was used (next message). */
export function advanceNonce(s: NonceState): NonceState {
  const nonce = currentNonce(s);
  const g = generateEntry(s.table[0]!, s.table[1]!);
  const table = s.table.slice();
  table[0] = g.t0;
  table[1] = g.t1;
  table[2 + s.idx] = g.entry;
  return { table, idx: nonce & 0x0f };
}

/**
 * Re-seeds after the pod reports a nonce resync (`PodState.resyncNonce`).
 * @param messageSequenceNum 4-bit sequence number of the rejected message
 */
export function resyncNonceState(o: { lot: number; tid: number; syncWord: number; sentNonce: number; messageSequenceNum: number }): NonceState {
  const sum = u32((o.sentNonce & 0xffff) + CRC16_TABLE[o.messageSequenceNum & 0xff]! + (o.lot & 0xffff) + (o.tid & 0xffff));
  return createNonceState(o.lot, o.tid, (sum & 0xffff) ^ (o.syncWord & 0xffff));
}
