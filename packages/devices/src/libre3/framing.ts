/**
 * GATT-level framing for Libre 3: write fragmentation, notify reassembly, data-plane frame trailer
 * and the glucose-notification prefix/suffix assembler.
 *
 * TypeScript port of RoundWhiteDiscKit `BLE/FrameAssembler.swift`, `DataPlane/DataFrame.swift` and
 * `DataPlaneNotificationAssembler` in `DataPlane/DataPlaneDecoder.swift` (MIT, (c) the
 * RoundWhiteDiscKit authors).
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { WRITE_CHUNK_PAYLOAD } from './constants';

/** Phone to sensor: `offset_LE2 || payload_chunk`, 18 payload bytes per fragment. */
export function fragmentForWrite(message: Bytes, chunkSize = WRITE_CHUNK_PAYLOAD): Bytes[] {
  const fragments: Bytes[] = [];
  for (let offset = 0; offset < message.length; offset += chunkSize) {
    const chunk = message.subarray(offset, Math.min(offset + chunkSize, message.length));
    fragments.push(concatBytes(Uint8Array.of(offset & 0xff, (offset >> 8) & 0xff), chunk));
  }
  return fragments;
}

/** Inverse of `fragmentForWrite` (used by the simulator and tests). */
export function reassembleWrites(fragments: readonly Bytes[]): Bytes {
  const parsed = fragments
    .map((f) => {
      if (f.length < 2) throw new Error('Write fragment too short');
      return { offset: f[0]! | (f[1]! << 8), body: f.subarray(2) };
    })
    .sort((a, b) => a.offset - b.offset);
  let out: Bytes = new Uint8Array(0);
  for (const piece of parsed) {
    if (piece.offset !== out.length) throw new Error('Discontinuous write offsets');
    out = concatBytes(out, piece.body);
  }
  return out;
}

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramingError';
  }
}

/** Sensor to phone: `sequence1 || payload_chunk`; the sequence byte must increment by one. */
export class NotifyReassembler {
  private buffer: Bytes = new Uint8Array(0);
  private expected: number | null = null;

  get available(): number {
    return this.buffer.length;
  }

  feed(fragment: Bytes): number {
    if (fragment.length === 0) throw new FramingError('Notify fragment too short');
    const seq = fragment[0]!;
    if (this.expected !== null && seq !== this.expected) throw new FramingError(`Notify sequence gap: expected ${this.expected}, got ${seq}`);
    this.expected = (seq + 1) & 0xff;
    this.buffer = concatBytes(this.buffer, fragment.subarray(1));
    return this.buffer.length;
  }

  take(n: number): Bytes {
    if (this.buffer.length < n) throw new FramingError(`Need ${n} bytes, have ${this.buffer.length}`);
    const head = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return head;
  }
}

/** Encrypted post-authorization notification: `encrypted_payload || seq_lo || seq_hi`. */
export interface DataFrame {
  /** Ciphertext followed by the 4-byte CCM tag. */
  readonly encrypted: Bytes;
  readonly seq: number;
  readonly type: number;
  /** 16-bit little-endian packet sequence used in the CCM nonce. */
  readonly sequenceNumber: number;
}

export function parseDataFrame(raw: Bytes): DataFrame {
  if (raw.length < 3) throw new FramingError(`Data frame too short (${raw.length} bytes)`);
  const seq = raw[raw.length - 2]!;
  const type = raw[raw.length - 1]!;
  return { encrypted: raw.slice(0, raw.length - 2), seq, type, sequenceNumber: seq | (type << 8) };
}

export const encodeDataFrame = (encrypted: Bytes, sequenceNumber: number): Bytes =>
  concatBytes(encrypted, Uint8Array.of(sequenceNumber & 0xff, (sequenceNumber >> 8) & 0xff));

const GLUCOSE_PREFIX_SIZE = 15;

/**
 * `glucoseData` frames arrive as a 15-byte prefix followed by a 20-byte suffix (which carries the
 * sequence trailer); both must be joined before the CCM tag can be verified.
 */
export class GlucoseNotificationAssembler {
  private prefix: Bytes | null = null;

  /** Returns the complete frame, or null while waiting for the suffix. */
  feed(fragment: Bytes): Bytes | null {
    if (this.prefix) {
      const joined = concatBytes(this.prefix, fragment);
      this.prefix = null;
      return joined;
    }
    if (fragment.length === GLUCOSE_PREFIX_SIZE) {
      this.prefix = fragment.slice();
      return null;
    }
    return fragment;
  }

  reset(): void {
    this.prefix = null;
  }
}
