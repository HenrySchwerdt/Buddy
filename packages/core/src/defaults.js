/** Conservative defaults for a new (simulated) user. */
export const DEFAULT_PROFILE = {
    basal: [
        { startMinute: 0, value: 0.8 },
        { startMinute: 6 * 60, value: 1.0 },
        { startMinute: 22 * 60, value: 0.85 },
    ],
    isf: [{ startMinute: 0, value: 50 }],
    carbRatio: [
        { startMinute: 0, value: 10 },
        { startMinute: 11 * 60, value: 12 },
    ],
    target: [{ startMinute: 0, value: { low: 100, high: 110 } }],
    diaHours: 6,
    insulinCurve: 'rapid-acting',
};
export const DEFAULT_LIMITS = {
    maxBasalRate: 3,
    maxBolus: 10,
    maxIOB: 6,
    maxAutoBolus: 1,
    suspendThreshold: 70,
    maxGlucoseAgeMinutes: 12,
    minAutoBolusIntervalMinutes: 3,
};
