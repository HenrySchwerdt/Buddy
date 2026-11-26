import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLE_WAKE_HOLD_MS, createTaskGuard } from '../task-guard';

function nativeStub() {
  const begun: string[] = [];
  const ended: number[] = [];
  let id = 100;
  return {
    begun,
    ended,
    api: {
      beginBackgroundTask: (name: string) => {
        begun.push(name);
        return ++id;
      },
      endBackgroundTask: (n: number) => void ended.push(n),
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('task guard with the native module', () => {
  it('run() begins a task, ends it when the work resolves and returns the result', async () => {
    const n = nativeStub();
    const guard = createTaskGuard(n.api);
    const result = await guard.run('loop', async () => {
      expect(guard.openCount).toBe(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(n.begun).toEqual(['loop']);
    expect(n.ended).toEqual([101]);
    expect(guard.openCount).toBe(0);
  });

  it('run() ends the task when the work throws', async () => {
    const n = nativeStub();
    const guard = createTaskGuard(n.api);
    await expect(guard.run('loop', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(n.ended).toEqual([101]);
    expect(guard.openCount).toBe(0);
  });

  it('end() is idempotent and ignores unknown handles', () => {
    const n = nativeStub();
    const guard = createTaskGuard(n.api);
    const h = guard.begin('x');
    guard.end(h);
    guard.end(h);
    guard.end(999);
    expect(n.ended).toEqual([101]);
  });

  it('a task iOS refused (id 0) is tracked in JS but never ended natively', () => {
    const n = nativeStub();
    const guard = createTaskGuard({ ...n.api, beginBackgroundTask: () => 0 });
    const h = guard.begin('x');
    expect(guard.openCount).toBe(1);
    guard.end(h);
    expect(guard.openCount).toBe(0);
    expect(n.ended).toEqual([]);
  });

  it('a native module that throws never breaks the work it wraps', async () => {
    const guard = createTaskGuard({
      beginBackgroundTask: () => {
        throw new Error('native');
      },
      endBackgroundTask: () => {
        throw new Error('native');
      },
    });
    await expect(guard.run('loop', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('task guard without the native module (Expo Go, Android, tests)', () => {
  it.each([null, undefined, {}])('falls back to JS bookkeeping for %j', async (native) => {
    const guard = createTaskGuard(native);
    await guard.run('loop', async () => {
      expect(guard.openCount).toBe(1);
    });
    expect(guard.openCount).toBe(0);
  });
});

describe('renewable task for BLE wake-ups', () => {
  it('opens one task for a burst of events and releases it after the hold time of the last one', () => {
    vi.useFakeTimers();
    const n = nativeStub();
    const task = createTaskGuard(n.api).renewable('ble', BLE_WAKE_HOLD_MS);
    task.touch();
    vi.advanceTimersByTime(20_000);
    task.touch(); // renews: the first 25 s would have ended at 25 s
    vi.advanceTimersByTime(20_000);
    expect(n.begun).toEqual(['ble']);
    expect(n.ended).toEqual([]);
    vi.advanceTimersByTime(5_001);
    expect(n.ended).toEqual([101]);
    task.touch(); // a later wake-up starts a new task
    expect(n.begun).toEqual(['ble', 'ble']);
    task.release();
    expect(n.ended).toEqual([101, 102]);
  });
});
