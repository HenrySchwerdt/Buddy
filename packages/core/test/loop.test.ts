import { describe, expect, it } from 'vitest';
import {
  createLoopEngine,
  createMemoryStore,
  defineAlgorithm,
  DEFAULT_LIMITS,
  silentLogger,
  type AlgorithmDecision,
  type CgmSource,
  type InsulinDose,
  type PumpDriver,
  MINUTE,
} from '../src';
import { flatProfile, pumpState, series, T0 } from './fixtures';

function fakePump() {
  const doses: InsulinDose[] = [];
  const calls: string[] = [];
  const pump: PumpDriver = {
    meta: { id: 'fake', name: 'Fake', manufacturer: 'test', description: '', transport: 'simulated', maturity: 'simulator' },
    connect: async () => {},
    disconnect: async () => {},
    status: async () => pumpState(),
    setTempBasal: async (rate, durationMin) => {
      calls.push(`temp ${rate}`);
      doses.push({ kind: 'tempBasal', id: `t${doses.length}`, date: T0, rate, durationMin });
      return { ok: true };
    },
    cancelTempBasal: async () => (calls.push('cancel'), { ok: true }),
    bolus: async (units, { automatic }) => {
      calls.push(`bolus ${units}`);
      doses.push({ kind: automatic ? 'smb' : 'bolus', id: `b${doses.length}`, date: T0, units });
      return { ok: true };
    },
    cancelBolus: async () => ({ ok: true }),
    suspend: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    history: async () => [...doses],
  };
  return { pump, calls };
}

const cgm = (bg: number): CgmSource => ({
  meta: { id: 'fake-cgm', name: 'Fake', manufacturer: 'test', description: '', transport: 'simulated', maturity: 'simulator' },
  start: async () => {},
  stop: async () => {},
  readings: async () => series(T0, bg, 0),
});

const algo = (d: AlgorithmDecision) =>
  defineAlgorithm({
    meta: { id: 'fixed', name: 'Fixed', shortName: 'F', description: '', version: '1', author: 't', maturity: 'experimental', capabilities: { tempBasal: true, autoBolus: true, predictions: [] } },
    settings: [],
    defaultSettings: {},
    decide: () => d,
  });

function engine(decision: AlgorithmDecision, mode: 'open' | 'closed', bg = 180) {
  const { pump, calls } = fakePump();
  const store = createMemoryStore();
  const e = createLoopEngine({
    clock: { now: () => T0 + MINUTE },
    pump,
    cgm: cgm(bg),
    store,
    log: silentLogger,
    config: () => ({ mode, algorithm: algo(decision), algorithmSettings: {}, profile: flatProfile, limits: DEFAULT_LIMITS }),
  });
  return { e, calls, store };
}

describe('LoopEngine', () => {
  it('enacts guarded decisions in closed loop', async () => {
    const { e, calls, store } = engine({ tempBasal: { rate: 9, durationMin: 30 }, autoBolus: 0.5, reason: 'r' }, 'closed');
    const run = await e.run();
    expect(calls).toEqual(['temp 3', 'bolus 0.5']);
    expect(run!.interventions.map((i) => i.code)).toContain('basal-clamped');
    expect(store.snapshot().loopRuns).toHaveLength(1);
    expect(store.snapshot().doses).toHaveLength(2);
  });

  it('only suggests in open loop', async () => {
    const { e, calls } = engine({ tempBasal: { rate: 2, durationMin: 30 }, reason: 'r' }, 'open');
    const run = await e.run();
    expect(calls).toEqual([]);
    expect(run!.guarded!.tempBasal).toEqual({ rate: 2, durationMin: 30 });
    expect(run!.enacted).toBeNull();
  });

  it('records algorithm exceptions as failed runs without dosing', async () => {
    const { pump, calls } = fakePump();
    const broken = { ...algo({ reason: '' }), decide: () => { throw new Error('boom'); } };
    const e = createLoopEngine({
      clock: { now: () => T0 + MINUTE }, pump, cgm: cgm(150), store: createMemoryStore(), log: silentLogger,
      config: () => ({ mode: 'closed', algorithm: broken, algorithmSettings: {}, profile: flatProfile, limits: DEFAULT_LIMITS }),
    });
    const run = await e.run();
    expect(run!.error).toBe('boom');
    expect(calls).toEqual([]);
  });

  it('never runs two cycles at once', async () => {
    const { e } = engine({ reason: '' }, 'open');
    const [a, b] = await Promise.all([e.run(), e.run()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
