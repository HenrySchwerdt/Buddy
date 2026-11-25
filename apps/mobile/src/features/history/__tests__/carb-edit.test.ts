import { describe, expect, it, vi } from 'vitest';
import type { CarbEntry } from '@buddy/core';

const T0 = Date.UTC(2026, 10, 25, 12);
const memory = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof import('@buddy/core').createMemoryStore> }));
vi.mock('@/runtime/runtime', async () => {
  const core = await import('@buddy/core');
  memory.store = core.createMemoryStore();
  return { store: memory.store, now: () => 0 };
});

import { updateCarbs } from '../actions';

describe('updateCarbs (Edit Meal)', () => {
  const seed = (entry: CarbEntry) => {
    memory.store.replace({ glucose: [], doses: [], carbs: [entry], loopRuns: [] });
    return entry;
  };

  it('keeps the note when only the amount changes', () => {
    const entry = seed({ id: 'c', date: T0, grams: 30, note: 'Pizza' });
    updateCarbs(entry, 45, entry.date);
    expect(memory.store.snapshot().carbs).toEqual([{ id: 'c', date: T0, grams: 45, note: 'Pizza' }]);
  });

  it('replaces the note when a new one is entered', () => {
    const entry = seed({ id: 'c', date: T0, grams: 30, note: 'Pizza' });
    updateCarbs(entry, 30, entry.date, 'Pasta');
    expect(memory.store.snapshot().carbs[0]?.note).toBe('Pasta');
  });

  it('removes the note when it is cleared', () => {
    const entry = seed({ id: 'c', date: T0, grams: 30, note: 'Pizza' });
    updateCarbs(entry, 30, entry.date, '  ');
    expect(memory.store.snapshot().carbs[0]).not.toHaveProperty('note');
  });
});

