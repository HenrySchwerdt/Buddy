import { Platform } from 'react-native';
import type { HealthKind, HealthSample } from './samples';

/** One health platform: HealthKit on iOS, Health Connect on Android. */
export interface HealthBackend {
  readonly label: 'Apple Health' | 'Health Connect';
  isAvailable(): Promise<boolean>;
  /** Asks for write access to glucose, carbs and insulin (insulin: iOS only). Resolves whether the request was completed. */
  requestPermission(): Promise<boolean>;
  /** Whether glucose may be written now (Trio `hasGlucoseWritePermission`). */
  canWriteGlucose(): Promise<boolean>;
  /** Writes the samples and returns the keys that were stored. Never throws for a single bad sample. */
  write(samples: readonly HealthSample[]): Promise<readonly string[]>;
  /** Deletes the record with this sync id (Trio `deleteGlucose` / `deleteMealData` / `deleteInsulin`). */
  remove(kind: HealthKind, syncId: string): Promise<void>;
}

let cached: HealthBackend | null | undefined;

/** The backend for this platform, or null on web. Native modules are loaded lazily so the other platform never touches them. */
export function getHealthBackend(): HealthBackend | null {
  if (cached !== undefined) return cached;
  try {
    if (Platform.OS === 'ios') cached = (require('./healthkit') as typeof import('./healthkit')).healthKitBackend;
    else if (Platform.OS === 'android') cached = (require('./health-connect') as typeof import('./health-connect')).healthConnectBackend;
    else cached = null;
  } catch (e) {
    console.warn(`[buddy] Health backend unavailable: ${e instanceof Error ? e.message : String(e)}`);
    cached = null;
  }
  return cached;
}
