/**
 * In-memory reading buffer for the Libre 3 source: sorted by date, bounded to 24 hours, with the
 * proximity check used to de-duplicate realtime, historical and clinical samples (replaces the
 * life-count sets of LibreLoop `LibreLoopCGMManager`, MIT, (c) the LibreLoop authors).
 */
import type { GlucoseReading } from '@buddy/core';

const MAX_AGE_MS = 24 * 60 * 60_000;

export class Libre3ReadingBuffer {
  private items: readonly GlucoseReading[] = [];

  add(reading: GlucoseReading): void {
    const merged = [...this.items.filter((r) => r.date !== reading.date), reading].sort((a, b) => a.date - b.date);
    const newest = merged[merged.length - 1]!.date;
    this.items = merged.filter((r) => r.date >= newest - MAX_AGE_MS);
  }

  since(since: number): GlucoseReading[] {
    return this.items.filter((r) => r.date > since);
  }

  latestDate(): number | null {
    return this.items.length === 0 ? null : this.items[this.items.length - 1]!.date;
  }

  /** True when a reading exists within `windowMs` of `date` (either side). */
  hasNear(date: number, windowMs: number): boolean {
    return this.items.some((r) => Math.abs(r.date - date) <= windowMs);
  }
}
