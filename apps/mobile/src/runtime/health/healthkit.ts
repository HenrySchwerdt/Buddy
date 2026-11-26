import {
  AuthorizationStatus,
  ComparisonPredicateOperator,
  InsulinDeliveryReason,
  authorizationStatusFor,
  deleteObjects,
  isHealthDataAvailableAsync,
  requestAuthorization,
  saveQuantitySample,
} from '@kingstinct/react-native-healthkit';
import type { HealthBackend } from './backend';
import type { HealthKind, HealthSample } from './samples';

/** Apple Health through HealthKit (port of Trio's HealthKitManager: same types, units and sync identifiers). */

const GLUCOSE = 'HKQuantityTypeIdentifierBloodGlucose';
const CARBS = 'HKQuantityTypeIdentifierDietaryCarbohydrates';
const INSULIN = 'HKQuantityTypeIdentifierInsulinDelivery';
const TO_SHARE = [GLUCOSE, CARBS, INSULIN] as const;

const TYPE_OF: Record<HealthKind, typeof GLUCOSE | typeof CARBS | typeof INSULIN> = { glucose: GLUCOSE, carbs: CARBS, insulin: INSULIN };

const syncMetadata = (syncId: string) => ({ HKExternalUUID: syncId, HKSyncIdentifier: syncId, HKSyncVersion: 1 });

async function save(s: HealthSample): Promise<void> {
  switch (s.kind) {
    case 'glucose':
      await saveQuantitySample(GLUCOSE, 'mg/dL', s.mgdl, new Date(s.date), new Date(s.date), syncMetadata(s.syncId));
      return;
    case 'carbs':
      await saveQuantitySample(CARBS, 'g', s.grams, new Date(s.date), new Date(s.date), syncMetadata(s.syncId));
      return;
    case 'insulin':
      // HealthKit throws for a sample that ends before it starts; the planner never produces one.
      await saveQuantitySample(INSULIN, 'IU', s.units, new Date(s.start), new Date(s.end), {
        ...syncMetadata(s.syncId),
        HKInsulinDeliveryReason: s.reason === 'basal' ? InsulinDeliveryReason.basal : InsulinDeliveryReason.bolus,
      });
      return;
  }
}

export const healthKitBackend: HealthBackend = {
  label: 'Apple Health',
  isAvailable: () => isHealthDataAvailableAsync(),
  async requestPermission() {
    if (!(await isHealthDataAvailableAsync())) throw new Error('Apple Health is not available on this device.');
    return requestAuthorization({ toShare: TO_SHARE });
  },
  async canWriteGlucose() {
    return authorizationStatusFor(GLUCOSE) === AuthorizationStatus.sharingAuthorized;
  },
  async write(samples) {
    const stored: string[] = [];
    for (const s of samples) {
      try {
        await save(s);
        stored.push(s.key);
      } catch (e) {
        console.warn(`[buddy] Apple Health write failed (${s.kind}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return stored;
  },
  async remove(kind, syncId) {
    if (authorizationStatusFor(TYPE_OF[kind]) !== AuthorizationStatus.sharingAuthorized) return;
    await deleteObjects(TYPE_OF[kind], { metadata: { withMetadataKey: 'HKSyncIdentifier', operatorType: ComparisonPredicateOperator.equalTo, value: syncId } });
  },
};
