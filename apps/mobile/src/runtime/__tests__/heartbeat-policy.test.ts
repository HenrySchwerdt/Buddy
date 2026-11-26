import { describe, expect, it } from 'vitest';
import { MINUTE } from '@buddy/core';
import { HEARTBEAT_LOOP_AGE_MS, heartbeatLoopDue } from '../heartbeat-policy';

const base = { now: 1_000 * MINUTE, lastRunAt: 1_000 * MINUTE - MINUTE, hasUnseenReading: false, looping: false };

describe('heartbeatLoopDue', () => {
  it('runs the loop for a reading the last run has not seen, however recent that run was', () => {
    expect(heartbeatLoopDue({ ...base, hasUnseenReading: true })).toBe(true);
  });

  it('skips a wake-up without a new reading while the last run is recent', () => {
    expect(heartbeatLoopDue(base)).toBe(false);
    expect(heartbeatLoopDue({ ...base, lastRunAt: base.now - HEARTBEAT_LOOP_AGE_MS + 1 })).toBe(false);
  });

  it('runs on any wake-up once the last run is 4.5 minutes old (a missed or late reading)', () => {
    expect(HEARTBEAT_LOOP_AGE_MS).toBe(4.5 * MINUTE);
    expect(heartbeatLoopDue({ ...base, lastRunAt: base.now - HEARTBEAT_LOOP_AGE_MS })).toBe(true);
    expect(heartbeatLoopDue({ ...base, lastRunAt: 0 })).toBe(true);
  });

  it('never starts a second cycle while one is running', () => {
    expect(heartbeatLoopDue({ ...base, hasUnseenReading: true, looping: true })).toBe(false);
    expect(heartbeatLoopDue({ ...base, lastRunAt: 0, looping: true })).toBe(false);
  });
});
