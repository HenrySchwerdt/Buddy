/**
 * Pure reconciliation of a bridge status with what this driver believes (port of InsightKit
 * `reconcileBolus` / `reconcileTempBasal` and the mode handling of `applyStatus`). Unreadable
 * fields are *unknown*, never "nothing": they change no record.
 */
import type { Millis } from '@buddy/core';
import { deliveryDurationMs } from './dosing-math';
import * as L from './ledger';
import { isDelivering, type BridgeStatus } from './models';
import type { InsightPersisted } from './state';

const MIN = 60_000;
/** A status must show our bolus missing this often before it counts as finished. */
const BOLUS_MISSES_REQUIRED = 2;

/** Matches our tracked bolus against a status. */
export function reconcileBolus(st: InsightPersisted, s: BridgeStatus, now: Millis): { state: InsightPersisted; ended: boolean } {
  const b = st.bolus;
  if (!b || s.bolusesAreUnreadable) return { state: st, ended: false };
  const active = s.boluses.find((a) => (b.bolusId !== null ? a.bolusId === b.bolusId : Math.abs(a.amount - b.units) < 0.005));
  if (active) {
    const delivered = Math.max(active.amount - active.remaining, 0);
    return { state: L.bolusProgress(st, delivered, active.bolusId), ended: false };
  }
  // A miss only counts when the status was read after the bridge accepted the bolus: an older cached status cannot know about it.
  const misses = s.timestamp !== null && s.timestamp > b.acceptedAt ? b.missCount + 1 : b.missCount;
  const overdue = now > b.sentAt + deliveryDurationMs(b.units) + 5 * MIN;
  if (misses >= BOLUS_MISSES_REQUIRED || overdue || b.stopped) {
    // The pump no longer runs it and nothing cancelled it: it completed. Its history event (if it comes) corrects the amount.
    return { state: L.finishBolus(st, b.stopped ? b.delivered : b.units, false), ended: true };
  }
  return { state: L.patchBolus(st, { missCount: misses }), ended: false };
}

/** A temp basal that is gone from the pump before its planned end ended early; one that ran out is simply over. */
export function reconcileTemp(st: InsightPersisted, s: BridgeStatus, now: Millis): InsightPersisted {
  const t = st.temp;
  if (!t || s.tbrIsUnreadable) return st; // unknown, not "no TBR"
  const plannedEnd = t.startedAt + t.durationMin * MIN;
  if (now >= plannedEnd) return { ...st, temp: null };
  const readAfterStart = s.timestamp !== null && s.timestamp > t.startedAt + 1000;
  // Only a status read *after* the TBR started can tell that it is gone or replaced.
  if (s.tbr === null && readAfterStart) return L.endTemp(st, Math.min(now, plannedEnd));
  // The pump runs another temp basal (changed on the pump itself): ours ended then.
  if (s.tbr !== null && s.tbr.percent !== t.percent && readAfterStart) return L.endTemp(st, Math.min(now, plannedEnd));
  return st;
}

/**
 * The pump's operating mode as seen by a status: record a suspend / resume that did not come from us.
 * A status read before our own mode command cannot undo it.
 */
export function reconcileMode(st: InsightPersisted, s: BridgeStatus, now: Millis, lastModeCommandAt: Millis | null): InsightPersisted {
  if (s.operatingMode === 'unknown') return st;
  const at = s.timestamp ?? now;
  if (lastModeCommandAt !== null && s.timestamp !== null && s.timestamp < lastModeCommandAt) return st;
  if (!isDelivering(s.operatingMode) && !st.suspended) return L.suspend(st, at, `insight-suspend-${at}`);
  if (isDelivering(s.operatingMode) && st.suspended) return L.resume(st, at);
  return st;
}
