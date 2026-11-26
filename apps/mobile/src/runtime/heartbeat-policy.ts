import { MINUTE } from '@buddy/core';

/** A heartbeat starts a loop cycle when the last one is at least this old (Trio loops every 5 minutes; slack for jitter). */
export const HEARTBEAT_LOOP_AGE_MS = 4.5 * MINUTE;

export interface HeartbeatDecisionInput {
  readonly now: number;
  /** Date of the newest loop run, 0 when there is none. */
  readonly lastRunAt: number;
  /** The CGM holds a reading newer than anything the store (and so the last run) has seen. */
  readonly hasUnseenReading: boolean;
  /** A loop cycle is already running (the engine would reject a second one anyway). */
  readonly looping: boolean;
}

/**
 * Trio's `recommendsLoop` on a heartbeat: a fresh reading is the heartbeat that matters (the loop runs on new
 * glucose); a heartbeat without one only loops when the previous cycle is old, which is the fallback for a missed
 * or late reading.
 */
export function heartbeatLoopDue(i: HeartbeatDecisionInput): boolean {
  if (i.looping) return false;
  return i.hasUnseenReading || i.now - i.lastRunAt >= HEARTBEAT_LOOP_AGE_MS;
}
