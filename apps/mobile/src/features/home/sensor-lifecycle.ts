/** Sensor lifecycle presentation (Header/SensorLifecycle): pure mapping from start / expiry to arc progress and status tag. */

export type LifecycleTheme = 'green' | 'orange' | 'red' | 'secondary';

export interface SensorLifecycle {
  /** Elapsed fraction of the phase, 0...1. */
  readonly progress: number;
  readonly arc: 'normal' | 'warning' | 'critical';
  readonly text: string;
  readonly theme: LifecycleTheme;
}

const HOUR = 3_600_000;
const WARNING_BEFORE_EXPIRY = 24 * HOUR;

/** "5d 14h", "22h left", "sensor expired", "warming up" (Duration.formattedTimeSpan(.largestTwoUnits)). */
export function sensorLifecycle(i: { startedAt: number; expiresAt: number; warmupEndsAt?: number | null }, now: number): SensorLifecycle {
  if (i.warmupEndsAt != null && now < i.warmupEndsAt) {
    return { progress: Math.min(1, Math.max(0, (now - i.startedAt) / (i.warmupEndsAt - i.startedAt))), arc: 'normal', text: 'warming up', theme: 'secondary' };
  }
  const total = i.expiresAt - i.startedAt;
  const left = i.expiresAt - now;
  const progress = total > 0 ? Math.min(1, Math.max(0, (now - i.startedAt) / total)) : 1;
  if (left <= 0) return { progress: 1, arc: 'critical', text: 'sensor expired', theme: 'red' };
  if (left < WARNING_BEFORE_EXPIRY) return { progress, arc: 'warning', text: `${Math.max(1, Math.floor(left / HOUR))}h left`, theme: 'orange' };
  const days = Math.floor(left / (24 * HOUR));
  const hours = Math.floor((left % (24 * HOUR)) / HOUR);
  return { progress, arc: 'normal', text: `${days}d ${hours}h`, theme: 'green' };
}
