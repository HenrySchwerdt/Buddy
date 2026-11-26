/**
 * TypeScript port of SyaiSensorLifecycle.swift and the fault model of SyaiSensorKit.swift from
 * SyaiKit (MIT, © 2026 Nightscout Foundation).
 *
 * Faults take precedence over timestamp math, because the cmd characteristic's "activated" (3)
 * does not distinguish warmup from active. A missing duration means the lifecycle is not known
 * yet, never a generic 14-day / 30-minute guess.
 */
export type SyaiFault =
  /** cmd characteristic latched to a fault state (>= 4): terminal, replace the sensor. */
  | { readonly kind: 'deviceStateObsolete'; readonly state: number }
  /** cmd reports below "activated" (0 starting, 1 self-test, 2 unactivated) on a sensor we hold an activation for. */
  | { readonly kind: 'deviceStateUnactivated'; readonly state: number }
  /** Client-side verdict from the plausibility guard. */
  | { readonly kind: 'signalImplausible' };

export type SyaiLifecycle =
  | { readonly phase: 'noSensor' }
  | { readonly phase: 'warmup'; readonly progress: number; readonly remainingMs: number }
  | { readonly phase: 'active'; readonly remainingMs: number; readonly totalMs: number }
  | { readonly phase: 'expired' }
  | { readonly phase: 'signalLost'; readonly since: number }
  | { readonly phase: 'failed' }
  | { readonly phase: 'unactivated' };

/** No reading for this long counts as signal loss. */
export const SIGNAL_LOST_THRESHOLD_MS = 6 * 60 * 1000;

export interface SensorAge {
  readonly elapsedSec: number;
  /** Wall-clock ms at which that elapsed value arrived. */
  readonly at: number;
}

/**
 * Seconds since activation: the sensor's own elapsed field where available, with the phone clock
 * spanning only the silence since that record arrived.
 */
export function sensorAgeSec(activatedAt: number | null, sensorAge: SensorAge | null, now: number): number | null {
  if (sensorAge) return sensorAge.elapsedSec + (now - sensorAge.at) / 1000;
  return activatedAt === null ? null : (now - activatedAt) / 1000;
}

export interface LifecycleInput {
  readonly sensorPaired: boolean;
  readonly activatedAt: number | null;
  readonly sensorAge?: SensorAge | null;
  readonly latestReadingAt: number | null;
  readonly hasLiveLink: boolean;
  readonly fault?: SyaiFault | null;
  readonly activeDurationSec?: number | null;
  readonly preheatDurationSec?: number | null;
  readonly now: number;
}

export function computeLifecycle(i: LifecycleInput): SyaiLifecycle {
  if (!i.sensorPaired) return { phase: 'noSensor' };
  const sensorAge = i.sensorAge ?? null;
  const wear = i.activeDurationSec ?? null;
  switch (i.fault?.kind) {
    case 'signalImplausible':
      return { phase: 'failed' };
    case 'deviceStateUnactivated':
      return { phase: 'unactivated' };
    case 'deviceStateObsolete': {
      const age = i.activatedAt !== null && wear !== null ? sensorAgeSec(i.activatedAt, sensorAge, i.now) : null;
      // A dead sensor past its wear window is simply expired, not failed.
      if (!(age !== null && wear !== null && age >= wear)) return { phase: 'failed' };
      break;
    }
    default:
      break;
  }
  const warmup = i.preheatDurationSec ?? null;
  if (i.activatedAt === null || wear === null || warmup === null) return { phase: 'noSensor' };
  const age = sensorAgeSec(i.activatedAt, sensorAge, i.now) ?? 0;
  if (age >= wear) return { phase: 'expired' };
  if (age < warmup) return { phase: 'warmup', progress: age / warmup, remainingMs: (warmup - age) * 1000 };
  const stale = i.latestReadingAt === null ? !i.hasLiveLink : Math.abs(i.now - i.latestReadingAt) > SIGNAL_LOST_THRESHOLD_MS;
  if (stale) return { phase: 'signalLost', since: i.latestReadingAt ?? i.activatedAt };
  return { phase: 'active', remainingMs: (wear - age) * 1000, totalMs: wear * 1000 };
}

export function faultStatusDetail(fault: SyaiFault): string {
  switch (fault.kind) {
    case 'deviceStateObsolete':
      return 'Sensor malfunction, replace sensor';
    case 'deviceStateUnactivated':
      return 'Sensor uninitialized, is it activated?';
    case 'signalImplausible':
      return 'Sensor readings implausible, consider replacing sensor';
  }
}

export const isTerminalFault = (_: SyaiFault): boolean => true;
