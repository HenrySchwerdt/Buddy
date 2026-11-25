import { describe, expect, it } from 'vitest';
import { BUILT_IN_ALGORITHMS } from '@buddy/algorithms';
import { COHORT, findScenario, runSimulation, type SimulationResult } from '../src';

/**
 * Closed-loop guardrails on the virtual cohort. These are regression tests: if a change to
 * an algorithm, the SafetyGuard or the LoopEngine makes outcomes clearly worse, CI fails.
 * Thresholds are deliberately loose; the benchmark (`pnpm sim`) is for comparisons.
 */
const avg = (rs: SimulationResult[], k: keyof SimulationResult['metrics']) => rs.reduce((s, r) => s + Number(r.metrics[k]), 0) / rs.length;

async function cohort(scenarioId: string, algoIndex: number, mode: 'open' | 'closed' = 'closed') {
  const scenario = findScenario(scenarioId);
  return Promise.all(COHORT.map((patient) => runSimulation({ algorithm: BUILT_IN_ALGORITHMS[algoIndex]!, patient, scenario, mode })));
}

describe('virtual cohort guardrails', () => {
  it('is deterministic', async () => {
    const a = await runSimulation({ algorithm: BUILT_IN_ALGORITHMS[0]!, patient: COHORT[0]!, scenario: findScenario('overnight') });
    const b = await runSimulation({ algorithm: BUILT_IN_ALGORITHMS[0]!, patient: COHORT[0]!, scenario: findScenario('overnight') });
    expect(a.metrics).toEqual(b.metrics);
  });

  describe.each(BUILT_IN_ALGORITHMS.map((a, i) => [a.meta.id, i] as const))('%s', (_id, i) => {
    it('keeps severe lows rare on a standard day and never errors', async () => {
      const rs = await cohort('standard-day', i);
      expect(avg(rs, 'tbr54')).toBeLessThanOrEqual(2);
      expect(rs.every((r) => r.loopErrors === 0)).toBe(true);
    });

    it('beats pump-only therapy when meals are not announced', async () => {
      const open = await cohort('unannounced', i, 'open');
      const closed = await cohort('unannounced', i);
      expect(avg(closed, 'tir')).toBeGreaterThan(avg(open, 'tir') + 40);
    });

    it('compensates a too-weak profile', async () => {
      const open = await cohort('resistant-day', i, 'open');
      const closed = await cohort('resistant-day', i);
      expect(avg(closed, 'tir')).toBeGreaterThan(avg(open, 'tir'));
    });

    it('holds overnight without lows', async () => {
      const rs = await cohort('overnight', i);
      expect(avg(rs, 'tbr70')).toBe(0);
    });
  });
});
