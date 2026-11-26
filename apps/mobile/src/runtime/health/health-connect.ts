import {
  SdkAvailabilityStatus,
  deleteRecordsByUuids,
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  insertRecords,
  requestPermission,
  type HealthConnectRecord,
  type Permission,
  type RecordType,
} from 'react-native-health-connect';
import type { HealthBackend } from './backend';
import type { HealthKind, HealthSample } from './samples';

/**
 * Health Connect on Android. It has no insulin delivery record, so only glucose and carbs are written
 * (Trio's insulin upload has no Android counterpart). `clientRecordId` is the sync id, which makes writes idempotent.
 */

const PERMISSIONS: Permission[] = [
  { accessType: 'write', recordType: 'BloodGlucose' },
  { accessType: 'write', recordType: 'Nutrition' },
];

const RECORD_OF: Partial<Record<HealthKind, RecordType>> = { glucose: 'BloodGlucose', carbs: 'Nutrition' };

let initialized = false;
async function ensureInitialized(): Promise<boolean> {
  if (initialized) return true;
  if ((await getSdkStatus()) !== SdkAvailabilityStatus.SDK_AVAILABLE) return false;
  initialized = await initialize();
  return initialized;
}

const iso = (t: number) => new Date(t).toISOString();

function toRecord(s: HealthSample): HealthConnectRecord | null {
  switch (s.kind) {
    case 'glucose':
      return {
        recordType: 'BloodGlucose',
        time: iso(s.date),
        level: { unit: 'milligramsPerDeciliter', value: s.mgdl },
        specimenSource: 1, // interstitial fluid
        mealType: 0,
        relationToMeal: 0,
        metadata: { clientRecordId: s.syncId, clientRecordVersion: 1 },
      };
    case 'carbs':
      return {
        recordType: 'Nutrition',
        startTime: iso(s.date),
        endTime: iso(s.date + 1000),
        totalCarbohydrate: { unit: 'grams', value: s.grams },
        mealType: 0,
        metadata: { clientRecordId: s.syncId, clientRecordVersion: 1 },
      };
    case 'insulin':
      return null;
  }
}

export const healthConnectBackend: HealthBackend = {
  label: 'Health Connect',
  isAvailable: ensureInitialized,
  async requestPermission() {
    if (!(await ensureInitialized())) throw new Error('Health Connect is not available. Install or update it from Google Play.');
    const granted = await requestPermission(PERMISSIONS);
    return PERMISSIONS.every((p) => granted.some((g) => 'recordType' in g && g.recordType === p.recordType && g.accessType === p.accessType));
  },
  async canWriteGlucose() {
    if (!(await ensureInitialized())) return false;
    return (await getGrantedPermissions()).some((g) => 'recordType' in g && g.recordType === 'BloodGlucose' && g.accessType === 'write');
  },
  async write(samples) {
    if (!(await ensureInitialized())) return [];
    const stored: string[] = [];
    // Insulin has no Health Connect record: mark it done so it is not retried forever.
    stored.push(...samples.filter((s) => s.kind === 'insulin').map((s) => s.key));
    const writable = samples.filter((s) => s.kind !== 'insulin');
    for (let i = 0; i < writable.length; i += 50) {
      const batch = writable.slice(i, i + 50);
      try {
        await insertRecords(batch.map(toRecord).filter((r): r is HealthConnectRecord => r !== null));
        stored.push(...batch.map((s) => s.key));
      } catch (e) {
        console.warn(`[buddy] Health Connect write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return stored;
  },
  async remove(kind, syncId) {
    const recordType = RECORD_OF[kind];
    if (!recordType || !(await ensureInitialized())) return;
    await deleteRecordsByUuids(recordType, [], [syncId]);
  },
};
