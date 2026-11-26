/**
 * Reconnect backfill: historical pages from the saved watermark (minus an overlap), then the recent
 * per-minute clinical window, then a second historical pass after the sensor's ~17 minute commit lag.
 *
 * TypeScript port of `requestBackfillIfNeeded` / `backfillStartLifeCount` in LibreLoop
 * `LibreLoopCGMManager+Pairing.swift` (MIT, (c) the LibreLoop authors), using the commands of
 * RoundWhiteDiscKit `PatchControlCommand` (MIT, (c) the RoundWhiteDiscKit authors).
 */
import type { Logger } from '@buddy/core';
import type { BackfillStream } from './history';
import type { Libre3Timing } from './timing';

const OVERLAP_LIFE_COUNTS = 10;
const LOOKBACK_LIFE_COUNTS = 180;
const RECENT_CLINICAL_WINDOW = 30;

export interface BackfillHost {
  send(stream: BackfillStream, fromLifeCount: number): Promise<void>;
  /** Newest accepted life count (persisted watermark). */
  watermark(): number | null;
}

/** Never 0: the sensor silently ignores "give me everything" requests, it wants a bounded range. */
export function backfillStartLifeCount(watermark: number | null, currentLifeCount: number): number {
  if (watermark !== null) return watermark > OVERLAP_LIFE_COUNTS ? watermark - OVERLAP_LIFE_COUNTS : 5;
  return currentLifeCount > LOOKBACK_LIFE_COUNTS ? currentLifeCount - LOOKBACK_LIFE_COUNTS : 5;
}

export class BackfillCoordinator {
  private requested = false;
  private failures = 0;
  private cancelled = false;
  private wake: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Real elapsed time (not the injected clock): these waits are about the link, not about sensor time. */
  private lastPageAt: number | null = null;

  constructor(private readonly host: BackfillHost, private readonly timing: Libre3Timing, private readonly log: Logger) {}

  /** Once per connection, anchored to a real realtime reading. */
  onRealtime(currentLifeCount: number): void {
    if (this.requested || this.cancelled) return;
    this.requested = true;
    void this.run(currentLifeCount).catch((e: unknown) => this.log.warn(`Libre 3: backfill stopped (${(e as Error).message})`));
  }

  /** A historical page arrived (resets the drain wait). */
  onHistoricalPage(): void {
    this.lastPageAt = Date.now();
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, ms);
    }).finally(() => {
      this.wake = null;
      this.timer = null;
    });
  }

  private async run(currentLifeCount: number): Promise<void> {
    const from = backfillStartLifeCount(this.host.watermark(), currentLifeCount);
    const clinicalFrom = currentLifeCount > RECENT_CLINICAL_WINDOW && currentLifeCount - RECENT_CLINICAL_WINDOW > from ? currentLifeCount - RECENT_CLINICAL_WINDOW : from;
    try {
      await this.host.send('historical', from);
    } catch (e) {
      this.failures++;
      this.log.warn(`Libre 3: historical backfill request failed (${this.failures}/${this.timing.maxBackfillFailures}): ${(e as Error).message}`);
      // retry on the next realtime reading, but not forever on a persistently rejecting sensor
      if (this.failures < this.timing.maxBackfillFailures) this.requested = false;
      return;
    }
    await this.waitForHistoricalDrain();
    await this.requestClinical(clinicalFrom);
    await this.sleep(this.timing.backfillPass2Ms);
    if (this.cancelled) return;
    const watermark = this.host.watermark() ?? from;
    try {
      await this.host.send('historical', watermark > 5 ? watermark - 5 : 1);
    } catch (e) {
      this.log.warn(`Libre 3: second backfill pass failed: ${(e as Error).message}`);
    }
  }

  /** A second patchControl write while the sensor is still answering the first fails, so wait for the pages to stop. */
  private async waitForHistoricalDrain(): Promise<void> {
    const start = Date.now();
    while (!this.cancelled && Date.now() - start < this.timing.historicalMaxWaitMs) {
      if (Date.now() - (this.lastPageAt ?? start) >= this.timing.historicalIdleMs) return;
      await this.sleep(Math.max(1, Math.min(250, this.timing.historicalIdleMs / 2)));
    }
  }

  private async requestClinical(fromLifeCount: number): Promise<void> {
    for (const [i, delay] of this.timing.clinicalRetryDelaysMs.entries()) {
      await this.sleep(delay);
      if (this.cancelled) return;
      try {
        await this.host.send('clinical', fromLifeCount);
        return;
      } catch (e) {
        const last = i === this.timing.clinicalRetryDelaysMs.length - 1;
        this.log.warn(`Libre 3: clinical backfill ${last ? `failed after ${i + 1} attempts` : `attempt ${i + 1} failed, retrying`}: ${(e as Error).message}`);
      }
    }
  }
}
