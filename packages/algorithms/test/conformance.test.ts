import { describe, expect, it } from 'vitest';
import { BUILT_IN_ALGORITHMS, checkConformance, createAlgorithmRegistry } from '../src';

describe('algorithm registry', () => {
  it('registers all built-ins with unique ids and valid default settings', () => {
    const r = createAlgorithmRegistry();
    expect(r.list().map((a) => a.meta.id)).toEqual(['oref-smb', 'oref-temp-basal', 'predictive', 'pid-ifb']);
    for (const a of r.list()) {
      for (const f of a.settings.flatMap((s) => s.fields)) expect(a.defaultSettings, `${a.meta.id}.${f.key}`).toHaveProperty(f.key);
    }
  });
});

describe.each(BUILT_IN_ALGORITHMS.map((a) => [a.meta.id, a] as const))('%s conformance', (_id, algo) => {
  it('passes every conformance case', () => {
    expect(checkConformance(algo)).toEqual([]);
  });
});
