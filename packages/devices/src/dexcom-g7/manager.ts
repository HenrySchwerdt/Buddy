/**
 * TypeScript port of G7CGMManager/G7CGMManager.swift and G7CGMManagerState.swift from
 * loopandlearn/G7SensorKit (MIT, © 2022 LoopKit Authors).
 *
 * Skipped: LoopKit delegate/HealthKit glue, CGM events, alerts, device log UI.
 * Kept: sensor following/discovery, suspected-session-end grace period (persisted so it
 * survives app restarts), duplicate suppression and the reading conversion.
 */
import { fromHex, hex, type Clock, type GlucoseReading, type Logger } from '@buddy/core';
import { clampGlucose } from '../dexcom-g6/ble-common';
import {
  algorithmHasReliableGlucose,
  algorithmSensorFailed,
  algorithmStateName,
  AlgorithmState,
  g7Trend,
  glucoseTimestamp,
  parseExtendedVersionMessage,
  parseG7GlucoseMessage,
  sameG7Message,
  type ExtendedVersionMessage,
  type G7BackfillMessage,
  type G7GlucoseMessage,
} from './messages';
import { G7_DEFAULT_LIFETIME_MS, G7_DEFAULT_WARMUP_MS, G7_GRACE_PERIOD_MS, G7Sensor, type G7SensorDelegate } from './sensor';

export const DEXCOM_G7_ID = 'dexcom-g7';
export const SUSPECTED_SESSION_END_GRACE_MS = 15 * 60 * 1000;

export interface G7State {
  readonly sensorID: string | null;
  readonly activatedAt: number | null;
  readonly extendedVersion: ExtendedVersionMessage | null;
  readonly latestReading: G7GlucoseMessage | null;
  readonly latestReadingTimestamp: number | null;
  readonly latestConnect: number | null;
  /**
   * When a suspected session end started its grace period, or null if none is pending.
   * Persisted so a grace period survives app termination: the deferred scan is an in-memory
   * timer, so without this a genuinely ended session would leave us tracking a sensor that
   * will never advertise again.
   */
  readonly suspectedSessionEndAt: number | null;
}

export const EMPTY_G7_STATE: G7State = {
  sensorID: null,
  activatedAt: null,
  extendedVersion: null,
  latestReading: null,
  latestReadingTimestamp: null,
  latestConnect: null,
  suspectedSessionEndAt: null,
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function serializeG7State(s: G7State): string {
  return JSON.stringify({
    sensorID: s.sensorID,
    activatedAt: s.activatedAt,
    extendedVersion: s.extendedVersion ? hex(s.extendedVersion.data) : null,
    latestReading: s.latestReading ? hex(s.latestReading.data) : null,
    latestReadingTimestamp: s.latestReadingTimestamp,
    latestConnect: s.latestConnect,
    suspectedSessionEndAt: s.suspectedSessionEndAt,
  });
}

export function parseG7State(raw: string | null): G7State {
  if (!raw) return EMPTY_G7_STATE;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const ev = str(o.extendedVersion);
    const lr = str(o.latestReading);
    return {
      sensorID: str(o.sensorID),
      activatedAt: num(o.activatedAt),
      extendedVersion: ev ? parseExtendedVersionMessage(fromHex(ev)) : null,
      latestReading: lr ? parseG7GlucoseMessage(fromHex(lr)) : null,
      latestReadingTimestamp: num(o.latestReadingTimestamp),
      latestConnect: num(o.latestConnect),
      suspectedSessionEndAt: num(o.suspectedSessionEndAt),
    };
  } catch {
    return EMPTY_G7_STATE;
  }
}

export interface G7ManagerDeps {
  readonly clock: Clock;
  readonly log: Logger;
  readonly persist: (state: G7State) => void;
  readonly onReadings: (readings: readonly { readonly syncId: string; readonly reading: GlucoseReading }[]) => void;
  readonly makeSensor: (delegate: G7SensorDelegate, sensorID: string | null) => G7Sensor;
  readonly suspectedSessionEndGraceMs?: number;
}

export class G7CgmManager implements G7SensorDelegate {
  readonly sensor: G7Sensor;
  suspectedSessionEndGraceMs: number;
  private stateValue: G7State;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(state: G7State, private readonly deps: G7ManagerDeps) {
    this.stateValue = state;
    this.suspectedSessionEndGraceMs = deps.suspectedSessionEndGraceMs ?? SUSPECTED_SESSION_END_GRACE_MS;
    this.sensor = deps.makeSensor(this, state.sensorID);
    this.restorePendingSuspectedSessionEnd();
  }

  get state(): G7State {
    return this.stateValue;
  }

  /** Session length minus the 12 h grace period, from the extended version when known. */
  get lifetimeMs(): number {
    const len = this.stateValue.extendedVersion?.sessionLength;
    return len !== undefined ? len * 1000 - G7_GRACE_PERIOD_MS : G7_DEFAULT_LIFETIME_MS;
  }

  get warmupDurationMs(): number {
    const w = this.stateValue.extendedVersion?.warmupDuration;
    return w !== undefined ? w * 1000 : G7_DEFAULT_WARMUP_MS;
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  scanForNewSensor(): void {
    this.cancelSuspectedSessionEndScan();
    this.deps.log.info('Dexcom G7: forgetting existing sensor and starting scan for new sensor');
    this.mutate({ sensorID: null, activatedAt: null, extendedVersion: null });
    this.sensor.scanForNewSensor();
  }

  // ── G7SensorDelegate ────────────────────────────────────────────────────────

  didDiscoverNewSensor(name: string, activatedAt: number): boolean {
    this.deps.log.info(`Dexcom G7: new sensor ${name} discovered, activated at ${new Date(activatedAt).toISOString()}`);
    const shouldSwitchToNewSensor = true;
    if (shouldSwitchToNewSensor) this.mutate({ sensorID: name, activatedAt });
    return shouldSwitchToNewSensor;
  }

  didReceiveExtendedVersion(extendedVersion: ExtendedVersionMessage): void {
    this.mutate({ extendedVersion });
  }

  sensorDidConnect(): void {
    this.mutate({ latestConnect: this.deps.clock.now() });
  }

  sensorDisconnected(suspectedEndOfSession: boolean): void {
    this.deps.log.info(`Dexcom G7: sensor disconnected, suspectedEndOfSession=${suspectedEndOfSession}`);
    if (suspectedEndOfSession) this.scheduleScanAfterSuspectedSessionEnd();
  }

  didError(error: Error): void {
    this.deps.log.error(`Dexcom G7: ${error.message}`);
  }

  didRead(message: G7GlucoseMessage): void {
    this.cancelSuspectedSessionEndScan();
    if (sameG7Message(message, this.stateValue.latestReading)) {
      this.deps.log.info('Dexcom G7: duplicate reading');
      return;
    }
    if (algorithmSensorFailed(message.algorithmState)) {
      this.deps.log.warn('Dexcom G7: detected failed sensor, scanning for new sensor');
      this.scanForNewSensor();
    }
    if (message.algorithmState === AlgorithmState.sessionEnded) {
      this.deps.log.warn('Dexcom G7: detected session ended, scanning for new sensor');
      this.scanForNewSensor();
    }
    const activationDate = this.sensor.activationDate;
    if (activationDate === null) {
      this.deps.log.error('Dexcom G7: unable to process sensor reading without activation date');
      return;
    }
    const ts = glucoseTimestamp(message);
    const latestReadingTimestamp = activationDate + ts * 1000;
    this.mutate({ latestReading: message, latestReadingTimestamp });
    if (message.glucose === null) return;
    if (!algorithmHasReliableGlucose(message.algorithmState)) {
      this.deps.log.info(`Dexcom G7: unreliable state ${algorithmStateName(message.algorithmState)}`);
      return;
    }
    const value = clampGlucose(message.glucose);
    if (value === null) return;
    this.deps.onReadings([
      { syncId: this.syncIdentifier(ts, latestReadingTimestamp), reading: { date: latestReadingTimestamp, value, trend: g7Trend(message), source: DEXCOM_G7_ID } },
    ]);
  }

  didReadBackfill(backfill: readonly G7BackfillMessage[]): void {
    this.cancelSuspectedSessionEndScan();
    const activationDate = this.sensor.activationDate;
    if (activationDate === null) {
      this.deps.log.error('Dexcom G7: unable to process backfill without activation date');
      return;
    }
    const out = backfill.flatMap((entry) => {
      if (entry.glucose === null) return [];
      if (!algorithmHasReliableGlucose(entry.algorithmState)) return [];
      const value = clampGlucose(entry.glucose);
      if (value === null) return [];
      const date = activationDate + entry.timestamp * 1000;
      return [{ syncId: this.syncIdentifier(entry.timestamp, date), reading: { date, value, trend: g7Trend(entry), source: DEXCOM_G7_ID } }];
    });
    if (out.length) this.deps.onReadings(out);
  }

  // ── suspected session end ───────────────────────────────────────────────────

  private scheduleScanAfterSuspectedSessionEnd(): void {
    if (this.stateValue.suspectedSessionEndAt !== null) {
      this.deps.log.info('Dexcom G7: suspected session end during active grace period; original deadline unchanged');
      return;
    }
    const graceStart = this.deps.clock.now();
    this.mutate({ suspectedSessionEndAt: graceStart });
    this.deps.log.info(`Dexcom G7: suspected session end; waiting ${this.suspectedSessionEndGraceMs / 60000} min for communication to resume`);
    this.scheduleGraceExpiry(graceStart, this.suspectedSessionEndGraceMs);
  }

  private scheduleGraceExpiry(graceStart: number, delayMs: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.handleSuspectedSessionEndGraceExpiry(graceStart);
    }, delayMs);
    this.timers.add(t);
  }

  handleSuspectedSessionEndGraceExpiry(graceStart: number): void {
    if (this.stateValue.suspectedSessionEndAt !== graceStart) {
      this.deps.log.info('Dexcom G7: communication received during suspected session end grace period; keeping sensor');
      return;
    }
    this.deps.log.info('Dexcom G7: no sensor communication since suspected session end');
    this.scanForNewSensor();
  }

  private cancelSuspectedSessionEndScan(): void {
    if (this.stateValue.suspectedSessionEndAt === null) return;
    this.mutate({ suspectedSessionEndAt: null });
  }

  /** Re-arms a persisted grace period (called on construction and when restarting after `dispose`). */
  restorePendingSuspectedSessionEnd(): void {
    const graceStart = this.stateValue.suspectedSessionEndAt;
    if (graceStart === null) return;
    const latest = this.stateValue.latestReadingTimestamp;
    if (latest !== null && latest > graceStart) {
      this.cancelSuspectedSessionEndScan();
      return;
    }
    const remaining = graceStart + this.suspectedSessionEndGraceMs - this.deps.clock.now();
    if (remaining <= 0) {
      this.deps.log.info('Dexcom G7: grace period for suspected session end expired while app was not running');
      this.scanForNewSensor();
      return;
    }
    this.scheduleGraceExpiry(graceStart, remaining);
  }

  private syncIdentifier(timestamp: number, date: number): string {
    const { activatedAt, sensorID } = this.stateValue;
    // Swift returns "invalid" here; a constant would collapse distinct readings in our buffer.
    if (activatedAt === null || sensorID === null) return `date ${date}`;
    return `${activatedAt / 3_600_000} ${sensorID} ${timestamp}`;
  }

  private mutate(changes: Partial<G7State>): void {
    const next = { ...this.stateValue, ...changes };
    this.stateValue = next;
    this.deps.persist(next);
  }
}
