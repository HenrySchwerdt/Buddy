export const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);
export const MIN = 60_000;
export const iso = (t) => new Date(t).toISOString();
export const PUMP = {
    reservoirUnits: 132.456,
    batteryPercent: 70,
    suspended: false,
    tempBasal: null,
    bolusing: false,
    bolusIncrement: 0.05,
    basalIncrement: 0.05,
    lastSync: T0 - MIN,
};
export const RUN = {
    date: T0,
    mode: 'closed',
    algorithmId: 'oref-smb',
    glucose: 152,
    iob: 2.1234,
    cob: 20.4,
    suggested: { tempBasal: { rate: 3, durationMin: 30 }, autoBolus: 0.6, reason: 'raw' },
    guarded: {
        tempBasal: { rate: 2.5, durationMin: 30 },
        autoBolus: 0.4,
        eventualGlucose: 141.6,
        insulinReq: 0.8,
        sensitivityRatio: 1.1,
        reason: 'COB: 20, Dev: 12',
        predictions: { iob: [152, 150.4], zt: [152, 140], cob: [152, 160], uam: [152, 155] },
    },
    interventions: [{ code: 'basal-clamped', message: 'Basal clamped to 2.5 U/h' }],
    enacted: { tempBasal: { rate: 2.5, durationMin: 30 }, autoBolus: 0.4 },
    durationMs: 40,
};
