import { computeAdjustedPercentage, isAdjustSensEnabled, MINUTE, type ActiveOverride, type ActiveTempTarget, type GlucoseUnit, type TargetBehavior } from '@buddy/core';
import { formatCountdown, formatPercent, formatGlucoseWithUnits, smbOffText } from '@/features/adjustments/format';

const NBSP = ' ';

export interface AdjustmentText {
  readonly title: string;
  readonly caption: string;
}

/** Remaining share of a timed adjustment (1 → 0); null when indefinite or unknown (`remainingFraction`). */
export function remainingFraction(startedAt: number, durationMin: number | null, now: number): number | null {
  if (durationMin === null || durationMin <= 0) return null;
  const total = durationMin * MINUTE;
  return Math.min(Math.max(1 - (now - startedAt) / total, 0), 1);
}

/** `overrideString`: remaining time, percentage, target, SMB toggle and SMB / UAM minutes, comma separated. */
export function overrideText(o: ActiveOverride, now: number, units: GlucoseUnit, defaults: { smbMinutes: number; uamMinutes: number }, hasTempTarget: boolean): AdjustmentText | null {
  const remaining = o.durationMin === null ? null : o.durationMin * MINUTE + (o.startedAt - now);
  const duration = remaining !== null && remaining > 0 ? formatCountdown(remaining) : '';
  const percent = o.percentage === 100 ? '' : formatPercent(o.percentage);
  const target = !o.target || hasTempTarget ? '' : formatGlucoseWithUnits(o.target, units);
  const showMinutes = (m: number | undefined, def: number) => !!m && !!o.overrideSmbMinutes && !o.disableSmb && m !== def;
  const smb = showMinutes(o.smbMinutes, defaults.smbMinutes) ? `SMB${NBSP}${o.smbMinutes}${NBSP}min` : '';
  const uam = showMinutes(o.uamMinutes, defaults.uamMinutes) ? `UAM${NBSP}${o.uamMinutes}${NBSP}min` : '';
  const parts = [duration, percent, target, smbOffText(o), smb, uam].filter(Boolean);
  return parts.length ? { title: o.name || 'Custom Override', caption: parts.join(', ') } : null;
}

/** `tempTargetString`: target (with the sensitivity percentage when it applies) and remaining time. */
export function tempTargetText(t: ActiveTempTarget, now: number, units: GlucoseUnit, b: TargetBehavior): AdjustmentText | null {
  const remaining = t.durationMin * MINUTE + (t.startedAt - now);
  const percentage = isAdjustSensEnabled(t.target, b) ? ` ${formatPercent(computeAdjustedPercentage(t.halfBasalTarget ?? b.halfBasalExerciseTarget, t.target, b.autosensMax))}` : '';
  const target = t.target === 0 ? '' : `${formatGlucoseWithUnits(t.target, units)}${percentage}`;
  const parts = [target, remaining > 0 ? formatCountdown(remaining) : ''].filter(Boolean);
  return parts.length ? { title: t.name || 'Temp Target', caption: parts.join(', ') } : null;
}
