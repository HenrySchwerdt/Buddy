/**
 * Turns decoded data-plane packets into Buddy glucose readings: quality gating, plausibility check,
 * 5-minute cadence, historical / clinical gap fill with de-duplication, sensor lifecycle and
 * end-of-life handling, backfill watermark.
 *
 * TypeScript port of the policy in LibreLoop `LibreLoopSensorMonitor.makeSample` and
 * `LibreLoopCGMManager+Pairing.swift` (`ingest`, `handleHistoricalPage`, `handleClinicalRecord`,
 * `notifySensorAttentionIfNeeded`; MIT, (c) the LibreLoop authors) on top of the RoundWhiteDiscKit
 * quality model (MIT, (c) the RoundWhiteDiscKit authors).
 *
 * Differences by design: readings the sensor flags as not actionable are NOT passed on to the
 * algorithm unless `useNonActionable` is set (Buddy has no display-only readings), and nothing
 * outside 39..401 mg/dL (`isPlausibleGlucose`) is ever emitted.
 */
import type { Clock, GlucoseReading, Logger, Trend } from '@buddy/core';
import { BackfillCoordinator, type BackfillHost } from './backfill';
import { LIBRE3_ID } from './constants';
import type { DecodedPacket } from './data-plane';
import type { ClinicalRecord, HistoricalPage } from './history';
import { DEFAULT_WARMUP_MINUTES, SensorLifecycle, isPatchTerminated, type PatchStatus, type SensorAttention } from './lifecycle';
import { assessRealtime, displayMgdl, type Libre3TrendKind, type RealtimeGlucose } from './realtime';
import { Libre3ReadingBuffer } from './readings';
import type { SensorStateHolder } from './state-holder';
import type { Libre3Timing } from './timing';
import { isPlausibleGlucose } from '../trend';

export interface PipelineSettings {
  /** Forward every realtime minute instead of one reading per ~5 minutes. */
  readonly minuteByMinute: boolean;
  /** Forward readings flagged "not actionable" (display only on the Abbott app). */
  readonly useNonActionable: boolean;
}

export const FORWARD_INTERVAL_MS = 270_000;
const DEDUPE_WINDOW_MS = 150_000;
const MINUTE_MS = 60_000;

/** Libre arrows: down, down-right, flat, up-right, up. */
export const TREND_MAP: Record<Libre3TrendKind, Trend> = {
  notDetermined: 'unknown',
  fallingQuickly: 'singleDown',
  falling: 'fortyFiveDown',
  stable: 'flat',
  rising: 'fortyFiveUp',
  risingQuickly: 'singleUp',
  raw: 'unknown',
};

export interface Libre3Telemetry {
  readonly lifeCount: number | null;
  readonly lastReadingAt: number | null;
  readonly lastIssue: string | null;
  readonly attention: SensorAttention;
}

export interface PipelineOptions {
  readonly clock: Clock;
  readonly log: Logger;
  readonly holder: SensorStateHolder;
  readonly buffer: Libre3ReadingBuffer;
  readonly settings: PipelineSettings;
  readonly timing: Libre3Timing;
  /** The sensor reported that it ended or must be replaced. */
  readonly onSensorEnded: (normally: boolean) => void;
}

export class ReadingPipeline {
  private anchor: number | null = null;
  private backfill: BackfillCoordinator | null = null;
  private lifeCount: number | null = null;
  private lastReadingAt: number | null = null;
  private lastIssue: string | null = null;
  private attention: SensorAttention = 'none';

  constructor(private readonly o: PipelineOptions) {}

  get telemetry(): Libre3Telemetry {
    return { lifeCount: this.lifeCount, lastReadingAt: this.lastReadingAt, lastIssue: this.lastIssue, attention: this.attention };
  }

  /** A new connection started streaming; `send` writes encrypted patchControl commands. */
  attach(host: Pick<BackfillHost, 'send'>): void {
    this.backfill?.cancel();
    this.backfill = new BackfillCoordinator({ send: host.send, watermark: () => this.o.holder.current.lastLifeCount }, this.o.timing, this.o.log);
  }

  detach(): void {
    this.backfill?.cancel();
    this.backfill = null;
  }

  handle(packet: DecodedPacket, at: number): void {
    const p = packet.payload;
    if (p.kind === 'realtime') this.onRealtime(p.reading, at);
    else if (p.kind === 'patchStatus') this.onPatchStatus(p.status, at);
    else if (p.kind === 'historicalPage') this.onHistoricalPage(p.page);
    else if (p.kind === 'clinical') this.onClinical(p.record);
  }

  private lifecycleFor(lifeCount: number): SensorLifecycle {
    const s = this.o.holder.current;
    return new SensorLifecycle(lifeCount, s.warmupMinutes ?? DEFAULT_WARMUP_MINUTES, s.wearDurationMinutes);
  }

  private advanceWatermark(lifeCount: number): void {
    const saved = this.o.holder.current.lastLifeCount;
    if (saved === null || lifeCount > saved) this.o.holder.update({ lastLifeCount: lifeCount });
  }

  private emit(reading: GlucoseReading): void {
    this.o.buffer.add(reading);
    this.lastReadingAt = Math.max(this.lastReadingAt ?? 0, reading.date);
  }

  private onRealtime(r: RealtimeGlucose, at: number): void {
    // the sensor's own age counter is authoritative for dating gap-fill samples
    this.anchor = at - r.lifeCount * MINUTE_MS;
    this.lifeCount = r.lifeCount;
    if (this.o.holder.current.needsReplacement) return;
    const mgdl = displayMgdl(r.current);
    if (mgdl === null) return; // warmup frames carry no value
    this.backfill?.onRealtime(r.lifeCount);
    this.advanceWatermark(r.lifeCount);

    const assessment = assessRealtime(r, this.lifecycleFor(r.lifeCount));
    if (!assessment.isUsable) {
      this.lastIssue = assessment.blocking.map((i) => i.kind).join(', ');
      return;
    }
    this.lastIssue = null;
    if (!r.actionable && !this.o.settings.useNonActionable) {
      this.lastIssue = 'notActionable';
      return;
    }
    if (!isPlausibleGlucose(mgdl)) {
      this.lastIssue = 'implausibleValue';
      return;
    }
    const newest = this.o.buffer.latestDate();
    if (!this.o.settings.minuteByMinute && newest !== null && at - newest < FORWARD_INTERVAL_MS) return;
    this.emit({ date: at, value: mgdl, trend: TREND_MAP[r.trend], source: LIBRE3_ID });
  }

  private onPatchStatus(s: PatchStatus, at: number): void {
    this.anchor ??= at - s.currentLifeCount * MINUTE_MS;
    this.lifeCount = s.currentLifeCount;
    if (s.effectiveAttention !== this.attention) {
      this.attention = s.effectiveAttention;
      this.o.log.warn(`Libre 3: sensor attention ${s.effectiveAttention} (state ${s.patchState}, error ${s.errorData})`);
    }
    const needsReplacement = s.effectiveAttention === 'replaceSensor' || s.effectiveAttention === 'sensorEnded';
    const current = this.o.holder.current;
    // sticky: a sensor that ended normally never turns into a failure retroactively
    const endedNormally = needsReplacement && (s.effectiveAttention === 'sensorEnded' || current.endedNormally);
    if (needsReplacement !== current.needsReplacement || endedNormally !== current.endedNormally) {
      this.o.holder.update({ needsReplacement, endedNormally });
    }
    if (needsReplacement && (isPatchTerminated(s) || s.effectiveAttention === 'sensorEnded')) this.o.onSensorEnded(endedNormally);
  }

  private onHistoricalPage(page: HistoricalPage): void {
    this.backfill?.onHistoricalPage();
    if (this.anchor === null) {
      this.o.log.info('Libre 3: historical page before the sensor clock is known; deferring');
      return;
    }
    if (this.o.holder.current.needsReplacement) return;
    for (const sample of page.samples) {
      if (sample.mgdl === null || !isPlausibleGlucose(sample.mgdl)) continue;
      this.addGapFill(sample.lifeCount, sample.mgdl);
    }
    this.advanceWatermark(page.endLifeCount);
  }

  /** Clinical records are per minute; only the 5-minute grid is kept (matches the historical grid). */
  private onClinical(record: ClinicalRecord): void {
    if (this.anchor === null || record.currentMgdl === null || record.lifeCount % 5 !== 0) return;
    if (this.o.holder.current.needsReplacement || !isPlausibleGlucose(record.currentMgdl)) return;
    this.addGapFill(record.lifeCount, record.currentMgdl);
  }

  private addGapFill(lifeCount: number, mgdl: number): void {
    if (this.anchor === null) return;
    const date = this.anchor + lifeCount * MINUTE_MS;
    if (date > this.o.clock.now() + MINUTE_MS) return; // sensor clock ahead of the anchor: not a real past sample
    if (this.o.buffer.hasNear(date, DEDUPE_WINDOW_MS)) return;
    this.emit({ date, value: mgdl, trend: 'unknown', source: LIBRE3_ID });
  }
}
