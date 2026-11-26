/**
 * TypeScript port of SyaiSensorMonitor.swift (frame handling, trend, backfill-label check),
 * CGMManager+Ingest.swift (warmup / wear / plausibility / 5-minute grid, backfill requests) and
 * CGMManager+Reconnect.swift (cmd-state faults) from SyaiKit (MIT, © 2026 Nightscout Foundation).
 *
 * Skipped: LoopKit delegate and HealthKit glue, alerts, the telemetry upload to Syai.
 * Kept: decode, sensor-time dating, warmup/past-wear gates, plausibility guard, grid thinning,
 * backfill of holes, and the persisted sensor/fault state.
 */
import type { Clock, GlucoseReading, Logger, Trend } from '@buddy/core';
import { isPlausibleGlucose } from '../trend';
import { firstBackfillableSequence, backfillRange, isOnForwardGrid, isPastWear, isWarmup, maxBackfillRequestCount } from './backfill';
import { HEALTHY_CMD_STATE, MMOL_TO_MGDL, SYAI_ID } from './constants';
import { rawChannels, type DecryptedFrame } from './frames';
import { computeLifecycle, faultStatusDetail, type SyaiFault, type SyaiLifecycle } from './lifecycle';
import { PlausibilityGuard } from './plausibility';
import { decodeGlucose } from './rpn';
import type { SyaiSensorRecord, SyaiState } from './state';
import { EMPTY_SYAI_STATE } from './state';
import type { BatchStatus } from './session';

/** Readings dated further ahead than this are a clock error, not a measurement. */
const FUTURE_TOLERANCE_MS = 60_000;

/** A record's elapsed-seconds field is `60 * index + offset`; half a record is the widest tolerance that still names one record. */
const ELAPSED_LABEL_TOLERANCE_SEC = 30;
const MAX_TREND_GAP_MIN = 6;

export interface SyaiManagerDeps {
  readonly clock: Clock;
  readonly log: Logger;
  readonly persist: (state: SyaiState) => void;
  readonly onReading: (syncId: string, reading: GlucoseReading) => void;
  /** Asks the live session for `count` records from `start`; rejects if no session or the write fails. */
  readonly requestBackfill: (start: number, count: number) => Promise<void>;
}

export function trendFromSyaiRate(rate: number | null): Trend {
  if (rate === null) return 'unknown';
  if (rate <= -3) return 'doubleDown';
  if (rate <= -2) return 'singleDown';
  if (rate < 2) return 'flat';
  if (rate < 3) return 'singleUp';
  return 'doubleUp';
}

interface TrendPoint {
  readonly sequence: number;
  readonly valueMgDL: number;
  readonly elapsedSec: number;
}

export class SyaiManager {
  private stateValue: SyaiState;
  private guard = new PlausibilityGuard();
  private elapsedOffset: number | null = null;
  /** Trend continuity is tracked per source so a backfill burst cannot corrupt the live trend. */
  private lastRealtime: TrendPoint | null = null;
  private lastHistorical: TrendPoint | null = null;
  private pendingBackfillFrom: number | null = null;
  private lastFrameAtValue: number | null = null;

  constructor(
    state: SyaiState,
    private readonly deps: SyaiManagerDeps,
  ) {
    this.stateValue = state;
  }

  get state(): SyaiState {
    return this.stateValue;
  }

  get lastFrameAt(): number | null {
    return this.lastFrameAtValue;
  }

  private mutate(patch: Partial<SyaiState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    this.deps.persist(this.stateValue);
  }

  /** Takes over `record`. A different sensor (MAC) starts a clean session; the same one only refreshes its record. */
  adoptSensor(record: SyaiSensorRecord): void {
    const current = this.stateValue.sensor;
    if (current && current.deviceInfo.mac === record.deviceInfo.mac) {
      this.mutate({ sensor: { ...record, peripheralId: record.peripheralId ?? current.peripheralId, activatedAt: record.activatedAt ?? current.activatedAt } });
      return;
    }
    this.guard = new PlausibilityGuard();
    this.elapsedOffset = null;
    this.lastRealtime = null;
    this.lastHistorical = null;
    this.pendingBackfillFrom = null;
    this.lastFrameAtValue = null;
    this.stateValue = { ...EMPTY_SYAI_STATE, sensor: record };
    this.deps.persist(this.stateValue);
  }

  setPeripheralId(id: string): void {
    const s = this.stateValue.sensor;
    if (s && s.peripheralId !== id) this.mutate({ sensor: { ...s, peripheralId: id } });
  }

  /** Terminal fault; sticky until another sensor is adopted. */
  markFault(fault: SyaiFault): void {
    if (this.stateValue.fault) return;
    this.deps.log.error(`Syai: sensor fault: ${faultStatusDetail(fault)}`);
    this.mutate({ fault });
  }

  /** The cmd characteristic read at connect: > 3 is dead, < 3 on a sensor we hold an activation for is unactivated. */
  noteCmdState(state: number | null): void {
    if (state === null) return;
    if (state > HEALTHY_CMD_STATE) this.markFault({ kind: 'deviceStateObsolete', state });
    else if (state < HEALTHY_CMD_STATE && this.stateValue.sensor?.activatedAt != null) this.markFault({ kind: 'deviceStateUnactivated', state });
  }

  lifecycle(now: number, hasLiveLink: boolean): SyaiLifecycle {
    const s = this.stateValue;
    const info = s.sensor?.deviceInfo;
    return computeLifecycle({
      sensorPaired: s.sensor !== null,
      activatedAt: s.sensor?.activatedAt ?? null,
      sensorAge: s.latestElapsedSeconds !== null && s.latestElapsedReceivedAt !== null ? { elapsedSec: s.latestElapsedSeconds, at: s.latestElapsedReceivedAt } : null,
      latestReadingAt: s.latestReadingTimestamp,
      hasLiveLink,
      fault: s.fault,
      activeDurationSec: info?.activeDurationSec ?? null,
      preheatDurationSec: info?.preheatDurationSec ?? null,
      now,
    });
  }

  handleBatch(status: BatchStatus): void {
    if (status.kind === 'complete') {
      this.deps.log.info('Syai: backfill batch complete');
      return;
    }
    if (status.surplusPackage >= 1) {
      // Requests are sized to fit one packet, so a paged answer means smaller packets than assumed.
      this.deps.log.warn(`Syai: backfill paged unexpectedly (${status.recordCount} records, surplus=${status.surplusPackage})`);
    }
  }

  handleFrame(frame: DecryptedFrame): void {
    this.lastFrameAtValue = frame.receivedAt;
    const sensor = this.stateValue.sensor;
    if (!sensor) return;
    try {
      const raw = rawChannels(frame.plaintext, frame.parseVersion);
      // A backfilled record's index is synthesised from its batch position; a firmware that
      // mis-serves a request relabels real readings onto the wrong minutes. The record's own
      // elapsed field is the check. Dropping (not relabelling) is deliberate: the grid watermark
      // re-requests whatever is dropped.
      if (!frame.isHistorical) this.elapsedOffset = raw.v2 - 60 * frame.sequence;
      else if (this.elapsedOffset !== null) {
        const implied = 60 * frame.sequence + this.elapsedOffset;
        if (Math.abs(raw.v2 - implied) >= ELAPSED_LABEL_TOLERANCE_SEC) {
          this.deps.log.warn(`Syai: dropping backfilled seq=${frame.sequence}: its own clock says record ${Math.trunc((raw.v2 - this.elapsedOffset) / 60)}`);
          return;
        }
      }
      const out = decodeGlucose(raw, sensor.deviceInfo.coefficients);
      const trend = this.deriveTrend(frame, out.adjustedGlucoseMgDL, raw.v2);
      this.ingest({
        frame,
        elapsedSec: raw.v2,
        current: raw.v0,
        valueMgDL: out.adjustedGlucoseMgDL,
        baseMgDL: out.rawGlucoseMgDL,
        trend,
      });
    } catch (e) {
      this.deps.log.error(`Syai: decode failed for seq=${frame.sequence}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private deriveTrend(frame: DecryptedFrame, valueMgDL: number, elapsedSec: number): Trend {
    const prev = frame.isHistorical ? this.lastHistorical : this.lastRealtime;
    const point: TrendPoint = { sequence: frame.sequence, valueMgDL, elapsedSec };
    if (frame.isHistorical) this.lastHistorical = point;
    else this.lastRealtime = point;
    if (!prev || frame.sequence <= prev.sequence) return 'unknown';
    const minutes = (elapsedSec - prev.elapsedSec) / 60;
    if (minutes <= 0 || minutes > MAX_TREND_GAP_MIN) return 'unknown';
    return trendFromSyaiRate((valueMgDL - prev.valueMgDL) / minutes);
  }

  private ingest(s: { frame: DecryptedFrame; elapsedSec: number; current: number; valueMgDL: number; baseMgDL: number; trend: Trend }): void {
    const { frame } = s;
    const state = this.stateValue;
    const sensor = state.sensor;
    if (!sensor || state.fault) {
      this.deps.log.info(`Syai: sensor marked failed; dropping seq=${frame.sequence}`);
      return;
    }
    const realtime = !frame.isHistorical;

    // `activatedAt` is normally exact already (the server's activeTime). Only a live frame's
    // receipt time may derive it: a backfilled frame's receipt time is "when we asked for history".
    let activatedAt = sensor.activatedAt;
    if (activatedAt === null && realtime) activatedAt = frame.receivedAt - s.elapsedSec * 1000;
    const date = activatedAt !== null ? activatedAt + s.elapsedSec * 1000 : frame.receivedAt;

    const info = sensor.deviceInfo;
    const warmup = isWarmup(s.elapsedSec, info.preheatDurationSec);
    const pastWear = isPastWear(s.elapsedSec, info.activeDurationSec);

    // Backfill is requested relative to the watermark held BEFORE this frame.
    if (realtime) this.firePendingBackfill(frame.sequence, frame.parseVersion);

    const newestLive = realtime && s.elapsedSec >= (state.latestElapsedSeconds ?? -1);
    const newGrid = isOnForwardGrid(frame.sequence) && frame.sequence > (state.lastGridSequence ?? 0);
    const patch: Partial<SyaiState> = {
      ...(sensor.activatedAt === null && activatedAt !== null ? { sensor: { ...sensor, activatedAt } } : {}),
      // Only a live record can be the newest one; it updates the elapsed/receipt pair together.
      ...(newestLive ? { latestReadingTimestamp: date, latestElapsedSeconds: s.elapsedSec, latestElapsedReceivedAt: frame.receivedAt } : {}),
      ...(newGrid ? { lastGridSequence: frame.sequence } : {}),
    };
    if (Object.keys(patch).length > 0) this.mutate(patch);

    if (warmup) return this.deps.log.info(`Syai: warmup reading seq=${frame.sequence}; not forwarding`);
    if (pastWear) return this.deps.log.info(`Syai: past wear seq=${frame.sequence}; not forwarding`);

    const event = this.guard.record(frame.sequence, s.current, s.baseMgDL / MMOL_TO_MGDL);
    if (event?.level === 'attention') this.deps.log.warn(`Syai: implausible data streak (${event.reason}) at seq=${frame.sequence}; suppressing forwarding while it holds`);
    if (event?.level === 'broken') {
      this.deps.log.error(`Syai: implausible data (${event.reason}) at seq=${frame.sequence}; declaring sensor failed`);
      this.markFault({ kind: 'signalImplausible' });
    }
    if (this.stateValue.fault || this.guard.attentionActive) return;
    if (!isOnForwardGrid(frame.sequence)) return;

    // Clamped LO/HI (36 / 450) and anything outside the plausible band is not a measurement.
    if (!isPlausibleGlucose(s.valueMgDL)) {
      this.deps.log.info(`Syai: seq=${frame.sequence} outside the plausible range (${s.valueMgDL} mg/dL); not forwarding`);
      return;
    }
    // A server activation time or phone clock that is off would date the reading in the future, and a
    // future reading hides every real one until the clock catches up (the loop reads `date > newest`).
    if (date > this.deps.clock.now() + FUTURE_TOLERANCE_MS) {
      this.deps.log.warn(`Syai: seq=${frame.sequence} is dated ${Math.round((date - this.deps.clock.now()) / 1000)} s in the future; not forwarding`);
      return;
    }
    this.deps.onReading(`${SYAI_ID}-${info.mac}-${frame.sequence}`, { date, value: s.valueMgDL, trend: s.trend, source: SYAI_ID });
  }

  /** Requests whatever is missing between the newest grid record held and the live one that just arrived. */
  private firePendingBackfill(newest: number, parseVersion: string): void {
    const have = this.pendingBackfillFrom ?? this.stateValue.lastGridSequence;
    if (have === null) return;
    this.pendingBackfillFrom = null;
    const preheat = this.stateValue.sensor?.deviceInfo.preheatDurationSec;
    if (preheat === undefined) return;
    const range = backfillRange(have, newest, firstBackfillableSequence(preheat), maxBackfillRequestCount(parseVersion));
    if (!range) return;
    this.pendingBackfillFrom = range.remaining;
    this.deps.log.info(`Syai: backfill requesting records ${range.start}…${range.start + range.count - 1}${range.remaining !== null ? ` (more queued from ${range.remaining})` : ''}`);
    this.deps.requestBackfill(range.start, range.count).catch((e: unknown) => {
      this.deps.log.warn(`Syai: backfill request failed: ${e instanceof Error ? e.message : String(e)}; hole stays queued`);
      if (this.pendingBackfillFrom === range.remaining) this.pendingBackfillFrom = have;
    });
  }
}
