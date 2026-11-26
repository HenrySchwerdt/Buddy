/** Port of Home/View/MultiUsePanelState.swift (highest priority wins). Buddy has no Tidepool login or release-notes state. */

export type MultiUsePanelState = 'notificationsDisabled' | 'pumpTimeMismatch' | 'cgmStale' | 'maxIOBZero' | 'dosingModeLimited' | 'stats';

/** Readings older than this offer manual glucose entry. */
export const CGM_STALE_AFTER_MS = 12 * 60_000;

export interface MultiUseInput {
  readonly notificationsDisabled: boolean;
  readonly pumpTimeMismatch: boolean;
  /** Epoch ms of the newest reading, null without any. */
  readonly lastGlucoseDate: number | null;
  readonly maxIOB: number;
  /** Automation is restricted (Trio: reductions-only / hypo-suspend-only; Buddy: closed loop blocked). */
  readonly dosingModeLimited: boolean;
  readonly now: number;
}

export function resolveMultiUsePanel(i: MultiUseInput): MultiUsePanelState {
  if (i.notificationsDisabled) return 'notificationsDisabled';
  if (i.pumpTimeMismatch) return 'pumpTimeMismatch';
  if (i.now - (i.lastGlucoseDate ?? -Infinity) > CGM_STALE_AFTER_MS) return 'cgmStale';
  if (i.dosingModeLimited) return 'dosingModeLimited';
  if (i.maxIOB <= 0) return 'maxIOBZero';
  return 'stats';
}
