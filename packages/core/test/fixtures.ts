import type { AlgorithmInput, GlucoseReading, PumpState, TherapyProfile } from '../src';
import { DEFAULT_LIMITS, constantSchedule, glucoseStatus, MINUTE } from '../src';

export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

export const flatProfile: TherapyProfile = {
  basal: constantSchedule(1),
  isf: constantSchedule(50),
  carbRatio: constantSchedule(10),
  target: constantSchedule({ low: 100, high: 100 }),
  diaHours: 6,
  insulinCurve: 'rapid-acting',
};

export const pumpState = (over: Partial<PumpState> = {}): PumpState => ({
  reservoirUnits: 150,
  batteryPercent: 80,
  suspended: false,
  tempBasal: null,
  bolusing: false,
  bolusIncrement: 0.05,
  basalIncrement: 0.05,
  lastSync: T0,
  ...over,
});

/** Readings every 5 min ending at `now`, newest first, with a constant slope per 5 min. */
export function series(now: number, last: number, slopePer5: number, count = 12, source = 'test'): GlucoseReading[] {
  return Array.from({ length: count }, (_, i) => ({ date: now - i * 5 * MINUTE, value: last - i * slopePer5, source }));
}

export function makeInput(over: Partial<AlgorithmInput> & { bg?: number; slope?: number } = {}): AlgorithmInput {
  const now = over.now ?? T0;
  const glucose = over.glucose ?? series(now, over.bg ?? 120, over.slope ?? 0);
  return {
    now,
    glucose,
    glucoseStatus: glucoseStatus(glucose)!,
    doses: [],
    carbs: [],
    profile: flatProfile,
    limits: DEFAULT_LIMITS,
    pump: pumpState(),
    iob: { date: now, iob: 0, bolusIob: 0, basalIob: 0, activity: 0 },
    cob: 0,
    ...over,
  };
}
