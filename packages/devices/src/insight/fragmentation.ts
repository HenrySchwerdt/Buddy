/**
 * Section 2 framing (port of InsightKit/Protocol/Fragmentation.swift): every GATT write or
 * notification carries one fragment `flags(1) | messageSeq(uint16 BE) | payload`.
 */
import type { Bytes } from '@buddy/core';
import { MAX_MESSAGE_SIZE, REASSEMBLY_TIMEOUT_MS } from './constants';

export const FRAGMENT_HEADER_SIZE = 3;
export const FLAG_FIRST = 0x01;
export const FLAG_LAST = 0x02;

/**
 * Splits a message into fragments no longer than `maxFragmentSize` bytes (header included).
 * `null` if the message is empty or too large, or the fragment size cannot hold a payload byte.
 */
export function fragmentMessage(message: Bytes, messageSeq: number, maxFragmentSize: number): Bytes[] | null {
  if (message.length === 0 || message.length > MAX_MESSAGE_SIZE) return null;
  const payloadSize = maxFragmentSize - FRAGMENT_HEADER_SIZE;
  if (!(payloadSize > 0)) return null;
  const seq = messageSeq & 0xffff;
  const out: Bytes[] = [];
  for (let offset = 0; offset < message.length; ) {
    const end = Math.min(offset + payloadSize, message.length);
    let flags = 0;
    if (offset === 0) flags |= FLAG_FIRST;
    if (end === message.length) flags |= FLAG_LAST;
    const fragment = new Uint8Array(FRAGMENT_HEADER_SIZE + end - offset);
    fragment[0] = flags;
    fragment[1] = seq >> 8;
    fragment[2] = seq & 0xff;
    fragment.set(message.subarray(offset, end), FRAGMENT_HEADER_SIZE);
    out.push(fragment);
    offset = end;
  }
  return out;
}

export type ReassemblyOutcome =
  | { readonly kind: 'complete'; readonly message: Bytes }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'dropped'; readonly reason: string }
  /** The message exceeded the maximum size; the caller may want to tell the peer. */
  | { readonly kind: 'tooLarge' };

/** Reassembles fragments of one message at a time (a FIRST fragment always starts over). */
export class Reassembler {
  private seq: number | null = null;
  private chunks: Bytes[] = [];
  private size = 0;
  private startedAt = 0;

  constructor(
    private readonly timeoutMs: number = REASSEMBLY_TIMEOUT_MS,
    private readonly maxSize: number = MAX_MESSAGE_SIZE,
  ) {}

  get isAssembling(): boolean {
    return this.seq !== null;
  }

  reset(): void {
    this.seq = null;
    this.chunks = [];
    this.size = 0;
    this.startedAt = 0;
  }

  /** Drops a stale partial message. Returns true when something was dropped. */
  expire(now: number): boolean {
    if (this.seq === null || now - this.startedAt <= this.timeoutMs) return false;
    this.reset();
    return true;
  }

  accept(fragment: Bytes, now: number): ReassemblyOutcome {
    this.expire(now);
    if (fragment.length < FRAGMENT_HEADER_SIZE) return { kind: 'dropped', reason: 'short fragment' };
    const flags = fragment[0]!;
    const seq = (fragment[1]! << 8) | fragment[2]!;
    const isFirst = (flags & FLAG_FIRST) !== 0;
    const isLast = (flags & FLAG_LAST) !== 0;

    if (isFirst) {
      // A FIRST fragment always starts over (this also covers "different messageSeq").
      this.reset();
      this.seq = seq;
      this.startedAt = now;
    } else {
      if (this.seq === null) return { kind: 'dropped', reason: 'continuation without start' };
      if (this.seq !== seq) {
        this.reset();
        return { kind: 'dropped', reason: 'sequence mismatch' };
      }
    }

    const payload = fragment.subarray(FRAGMENT_HEADER_SIZE);
    if (this.size + payload.length > this.maxSize) {
      this.reset();
      return { kind: 'tooLarge' };
    }
    this.chunks.push(payload.slice());
    this.size += payload.length;
    if (!isLast) return { kind: 'incomplete' };

    const message = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      message.set(c, o);
      o += c.length;
    }
    this.reset();
    return message.length === 0 ? { kind: 'dropped', reason: 'empty message' } : { kind: 'complete', message };
  }
}
