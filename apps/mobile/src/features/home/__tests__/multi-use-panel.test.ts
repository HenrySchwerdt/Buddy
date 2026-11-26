import { describe, expect, it } from 'vitest';
import { CGM_STALE_AFTER_MS, resolveMultiUsePanel, type MultiUseInput } from '../multi-use-panel';

const NOW = 1_000_000_000;
const base: MultiUseInput = { notificationsDisabled: false, pumpTimeMismatch: false, lastGlucoseDate: NOW - 60_000, maxIOB: 3, dosingModeLimited: false, now: NOW };

describe('resolveMultiUsePanel', () => {
  it('shows stats when nothing is wrong', () => expect(resolveMultiUsePanel(base)).toBe('stats'));
  it('applies the Trio priority order', () => {
    const all = { ...base, notificationsDisabled: true, pumpTimeMismatch: true, lastGlucoseDate: null, maxIOB: 0, dosingModeLimited: true };
    expect(resolveMultiUsePanel(all)).toBe('notificationsDisabled');
    expect(resolveMultiUsePanel({ ...all, notificationsDisabled: false })).toBe('pumpTimeMismatch');
    expect(resolveMultiUsePanel({ ...all, notificationsDisabled: false, pumpTimeMismatch: false })).toBe('cgmStale');
    expect(resolveMultiUsePanel({ ...all, notificationsDisabled: false, pumpTimeMismatch: false, lastGlucoseDate: NOW })).toBe('dosingModeLimited');
    expect(resolveMultiUsePanel({ ...base, maxIOB: 0 })).toBe('maxIOBZero');
  });
  it('treats readings older than 12 minutes as stale, exactly 12 as fresh', () => {
    expect(resolveMultiUsePanel({ ...base, lastGlucoseDate: NOW - CGM_STALE_AFTER_MS })).toBe('stats');
    expect(resolveMultiUsePanel({ ...base, lastGlucoseDate: NOW - CGM_STALE_AFTER_MS - 1 })).toBe('cgmStale');
  });
});
