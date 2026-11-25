/**
 * TypeScript port of the GlucoseBackfillFrameBuffer in Messages/GlucoseBackfillMessage.swift
 * from loopandlearn/CGMBLEKit (MIT, © LoopKit Authors).
 *
 * The frame buffer is an immutable value here: `appendBackfillFrame` returns a new buffer.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { crc16, GLUCOSE_SUB_MESSAGE_SIZE, parseGlucoseSubMessage, type GlucoseSubMessage } from './messages';

export interface BackfillFrameBuffer {
  readonly identifier: number;
  readonly frames: readonly Bytes[];
}

export const createBackfillFrameBuffer = (identifier: number): BackfillFrameBuffer => ({ identifier, frames: [] });

export function appendBackfillFrame(buffer: BackfillFrameBuffer, frame: Bytes): BackfillFrameBuffer {
  // Byte 0 is the frame index
  // Byte 1 is the identifier
  if (frame.length <= 2 || frame[0] !== buffer.frames.length + 1 || frame[1] !== buffer.identifier) return buffer;
  return { ...buffer, frames: [...buffer.frames, frame.slice()] };
}

export const backfillByteCount = (buffer: BackfillFrameBuffer): number => buffer.frames.reduce((n, f) => n + f.length, 0);

/** CRC over all frames *including* their 2-byte index/identifier headers. */
export const backfillCrc16 = (buffer: BackfillFrameBuffer): number => crc16(concatBytes(...buffer.frames));

export function backfillGlucose(buffer: BackfillFrameBuffer): GlucoseSubMessage[] {
  // Drop the first 2 bytes from each frame
  const data = concatBytes(...buffer.frames.map((f) => f.subarray(2)));
  // Drop the first 4 bytes from the combined message
  // Byte 0: ??
  // Byte 1: ??
  // Byte 2: ?? (only seen 0 so far)
  // Byte 3: ?? (only seen 0 so far)
  const glucoseData = data.subarray(4);
  const out: GlucoseSubMessage[] = [];
  for (let o = 0; o + GLUCOSE_SUB_MESSAGE_SIZE <= glucoseData.length; o += GLUCOSE_SUB_MESSAGE_SIZE) {
    const m = parseGlucoseSubMessage(glucoseData, o);
    if (m) out.push(m);
  }
  return out;
}
