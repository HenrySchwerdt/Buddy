/**
 * TypeScript port of SyaiPlausibilityGuard.swift from SyaiKit (MIT, © 2026 Nightscout
 * Foundation). Client-side data-plausibility engine: the firmware never reports sensor-health
 * failures in its cmd state, so health is detected from the decoded data stream.
 *
 * `attentionActive` suppresses forwarding to the dosing path; the `broken` verdict latches the
 * sensor as failed. Glucose is evaluated unclamped. Fed every post-warmup sample, live or
 * backfilled, in whatever order it arrives; dedup is per sequence, not a watermark, so a
 * backfilled gap behind an already-fed live sample still reaches the detectors.
 *
 * Deliberately a small mutable class (streak counters and a fed-sequence set that grows with the
 * sensor's life); everything persisted around it is immutable.
 */
export type PlausibilityReason = 'lowCurrent' | 'glucoseHigh0' | 'glucoseLow0' | 'glucoseHigh1' | 'glucoseLow1' | 'shake';
export type PlausibilityLevel = 'attention' | 'broken';
export interface PlausibilityEvent {
  readonly reason: PlausibilityReason;
  readonly level: PlausibilityLevel;
}

export const LOW_CURRENT_THRESHOLD = 2000;
export const HIGH0_THRESHOLD = 40; // mmol/L
export const LOW0_THRESHOLD = 1;
export const HIGH1_THRESHOLD = 35;
export const LOW1_THRESHOLD = 2.1;
export const ATTENTION_COUNT0 = 5;
export const BROKEN_COUNT0 = 35;
export const ATTENTION_COUNT1 = 10;
export const BROKEN_COUNT1 = 250;
export const SHAKE_MIN_DELTA_MMOL = 2;
export const SHAKE_POINT_LIMIT = 30;

interface Detector {
  readonly reason: PlausibilityReason;
  readonly isError: (current: number, mmol: number) => boolean;
  readonly attentionCount: number;
  readonly brokenCount: number;
}

const DETECTORS: readonly Detector[] = [
  { reason: 'lowCurrent', isError: (c) => c < LOW_CURRENT_THRESHOLD, attentionCount: ATTENTION_COUNT0, brokenCount: BROKEN_COUNT0 },
  { reason: 'glucoseHigh0', isError: (_, m) => m > HIGH0_THRESHOLD, attentionCount: ATTENTION_COUNT0, brokenCount: BROKEN_COUNT0 },
  { reason: 'glucoseLow0', isError: (_, m) => m < LOW0_THRESHOLD, attentionCount: ATTENTION_COUNT0, brokenCount: BROKEN_COUNT0 },
  { reason: 'glucoseHigh1', isError: (_, m) => m > HIGH1_THRESHOLD, attentionCount: ATTENTION_COUNT1, brokenCount: BROKEN_COUNT1 },
  { reason: 'glucoseLow1', isError: (_, m) => m < LOW1_THRESHOLD, attentionCount: ATTENTION_COUNT1, brokenCount: BROKEN_COUNT1 },
];

export class PlausibilityGuard {
  private readonly attentionReasons = new Set<PlausibilityReason>();
  private readonly streaks = new Map<PlausibilityReason, number>();
  private readonly shakePoints = new Set<number>();
  private readonly fedSequences = new Set<number>();
  private window: readonly { readonly sequence: number; readonly glucoseMmolL: number }[] = [];

  get attentionActive(): boolean {
    return this.attentionReasons.size > 0;
  }

  /** Feeds one post-warmup sample; returns the highest-severity threshold crossing it caused. */
  record(sequence: number, current: number, glucoseMmolL: number): PlausibilityEvent | null {
    if (this.fedSequences.has(sequence)) return null;
    this.fedSequences.add(sequence);

    let event: PlausibilityEvent | null = null;
    for (const d of DETECTORS) {
      const streak = d.isError(current, glucoseMmolL) ? (this.streaks.get(d.reason) ?? 0) + 1 : 0;
      this.streaks.set(d.reason, streak);
      if (streak >= d.attentionCount) {
        if (streak === d.attentionCount && event === null) event = { reason: d.reason, level: 'attention' };
        this.attentionReasons.add(d.reason);
      } else {
        this.attentionReasons.delete(d.reason);
      }
      if (streak === d.brokenCount) event = { reason: d.reason, level: 'broken' };
    }

    this.window = [...this.window, { sequence, glucoseMmolL }].slice(-3);
    const extremum = this.shakeExtremumSequence();
    if (extremum !== null && !this.shakePoints.has(extremum)) {
      this.shakePoints.add(extremum);
      if (this.shakePoints.size === SHAKE_POINT_LIMIT && event?.level !== 'broken') event = { reason: 'shake', level: 'broken' };
    }
    return event;
  }

  /** A shake point: a local extremum across three consecutive records, >= 2 mmol/L from both neighbours. */
  private shakeExtremumSequence(): number | null {
    const w = this.window;
    if (w.length !== 3) return null;
    const [a, b, c] = w as readonly [(typeof w)[number], (typeof w)[number], (typeof w)[number]];
    if (a.sequence + 1 !== b.sequence || b.sequence + 1 !== c.sequence) return null;
    const isExtremum = (b.glucoseMmolL > a.glucoseMmolL && b.glucoseMmolL > c.glucoseMmolL) || (a.glucoseMmolL > b.glucoseMmolL && c.glucoseMmolL > b.glucoseMmolL);
    if (!isExtremum) return null;
    if (Math.abs(b.glucoseMmolL - a.glucoseMmolL) < SHAKE_MIN_DELTA_MMOL || Math.abs(b.glucoseMmolL - c.glucoseMmolL) < SHAKE_MIN_DELTA_MMOL) return null;
    return b.sequence;
  }
}
