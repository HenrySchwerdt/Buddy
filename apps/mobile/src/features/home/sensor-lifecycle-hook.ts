import { useMemo } from 'react';
import { currentCgm, useRuntime } from '@/runtime/runtime';
import { sensorLifecycle, type SensorLifecycle } from './sensor-lifecycle';

/** What a CGM would have to report for Home to draw the lifecycle arc and tag. */
export interface CgmSensorInfo {
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly warmupEndsAt?: number | null;
}

/** The running CGM's sensor session (`CgmSource.sensorInfo`); null when the driver does not know one. */
function readSensorInfo(): CgmSensorInfo | null {
  try {
    return currentCgm()?.sensorInfo?.() ?? null;
  } catch {
    return null;
  }
}

export function useSensorLifecycle(): SensorLifecycle | null {
  const now = useRuntime((s) => s.now);
  // `now` ticks every loop poll, so the info is re-read then (the driver builds a new object each call).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const info = useMemo(readSensorInfo, [now]);
  return useMemo(() => (info ? sensorLifecycle(info, now) : null), [info, now]);
}
