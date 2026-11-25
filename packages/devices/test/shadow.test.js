import { describe, expect, it } from 'vitest';
import { createLoopEngine, createMemoryStore, silentLogger, DEFAULT_LIMITS, DEFAULT_PROFILE } from '@buddy/core';
import { orefSmb } from '@buddy/algorithms';
import { nightscoutFollower, parseDeviceStatus, parseNightscoutProfile, parseTreatmentsToCarbs, parseTreatmentsToDoses } from '../src';
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
/** Shapes as uploaded by Trio (PumpHistoryStorage / CarbsStorage / devicestatus). */
const TREATMENTS = [
    { _id: 'a', eventType: 'SMB', insulin: 0.35, created_at: iso(10), enteredBy: 'Trio' },
    { _id: 'b', eventType: 'Bolus', insulin: 4.2, created_at: iso(60), enteredBy: 'Trio' },
    { _id: 'c', eventType: 'Temp Basal', absolute: 1.6, rate: 1.6, duration: 30, created_at: iso(5) },
    { _id: 'd', eventType: 'Carb Correction', carbs: 45, created_at: iso(62) },
    { _id: 'e', eventType: 'Note', notes: 'hello', created_at: iso(3) },
    { _id: 'f', eventType: 'Bolus', insulin: 999, created_at: iso(2) },
];
const DEVICESTATUS = [
    {
        device: 'Trio',
        created_at: iso(1),
        openaps: { enacted: { timestamp: iso(1), rate: 1.6, duration: 30, units: 0.35, eventualBG: 142, IOB: 2.1, COB: 20, reason: 'COB: 20, Dev: 12', predBGs: { IOB: [150, 148], ZT: [150, 140] } } },
        pump: { reservoir: 132.5, battery: { percent: 70 }, status: { suspended: false } },
    },
];
describe('Nightscout follower parsing', () => {
    it('maps Trio treatments to doses and carbs, rejecting implausible values', () => {
        const doses = parseTreatmentsToDoses(TREATMENTS);
        expect(doses.map((d) => d.kind).sort()).toEqual(['bolus', 'smb', 'tempBasal']);
        expect(doses.find((d) => d.kind === 'tempBasal')).toMatchObject({ rate: 1.6, durationMin: 30 });
        expect(parseTreatmentsToCarbs(TREATMENTS)).toEqual([expect.objectContaining({ grams: 45 })]);
    });
    it('reads the enacted decision and pump status', () => {
        const { decision, pump } = parseDeviceStatus(DEVICESTATUS);
        expect(decision).toMatchObject({ source: 'Trio', tempBasal: { rate: 1.6, durationMin: 30 }, autoBolus: 0.35, eventualGlucose: 142 });
        expect(pump.reservoirUnits).toBe(132.5);
    });
    it('imports a mmol/L Nightscout profile in mg/dL', () => {
        const p = parseNightscoutProfile([
            {
                defaultProfile: 'Default',
                store: {
                    Default: {
                        units: 'mmol',
                        dia: 7,
                        basal: [{ time: '00:00', value: 0.8 }, { time: '06:00', value: 1.1 }],
                        sens: [{ time: '00:00', value: 2.5 }],
                        carbratio: [{ time: '00:00', value: 10 }],
                        target_low: [{ time: '00:00', value: 5.5 }],
                        target_high: [{ time: '00:00', value: 6 }],
                    },
                },
            },
        ]);
        expect(p.basal).toEqual([{ startMinute: 0, value: 0.8 }, { startMinute: 360, value: 1.1 }]);
        expect(p.isf[0].value).toBe(45);
        expect(p.target[0].value).toEqual({ low: 99, high: 108 });
        expect(p.diaHours).toBe(7);
    });
});
describe('shadow mode end to end', () => {
    const fetchStub = (async (url) => {
        const body = url.includes('treatments') ? TREATMENTS : DEVICESTATUS;
        return { ok: true, status: 200, json: async () => body };
    });
    const ctx = { clock: { now: () => NOW }, log: silentLogger, fetch: fetchStub };
    it('never accepts commands', async () => {
        const pump = nightscoutFollower.create({ url: 'https://ns.example', token: 't' }, ctx);
        expect((await pump.bolus(1, { automatic: false })).ok).toBe(false);
        expect((await pump.setTempBasal(2, 30)).ok).toBe(false);
    });
    it('runs Buddy open-loop on Trio data and records Trio as reference', async () => {
        const pump = nightscoutFollower.create({ url: 'https://ns.example', token: 't' }, ctx);
        const cgm = {
            meta: { ...pump.meta, id: 'test-cgm' },
            start: async () => { },
            stop: async () => { },
            readings: async () => Array.from({ length: 24 }, (_, i) => ({ date: NOW - i * 5 * 60_000, value: 160 - i, source: 'ns' })),
        };
        const store = createMemoryStore();
        const engine = createLoopEngine({
            clock: ctx.clock,
            pump,
            cgm,
            store,
            log: silentLogger,
            config: () => ({ mode: 'closed', algorithm: orefSmb, algorithmSettings: orefSmb.defaultSettings, profile: DEFAULT_PROFILE, limits: DEFAULT_LIMITS }),
        });
        const run = await engine.run();
        expect(run.error).toBeUndefined();
        expect(run.mode).toBe('open');
        expect(run.enacted).toBeNull();
        expect(run.reference).toMatchObject({ source: 'Trio', autoBolus: 0.35 });
        expect(store.snapshot().carbs).toHaveLength(1);
        expect(run.iob).toBeGreaterThan(3);
    });
});
