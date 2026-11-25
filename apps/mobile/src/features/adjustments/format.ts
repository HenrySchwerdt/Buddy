import { computeAdjustedPercentage, isAdjustSensEnabled, type GlucoseUnit, type OverridePreset, type TargetBehavior, type TempTargetPreset } from '@buddy/core';
import { fmtG } from '@/features/format';

const NBSP = ' ';
const MIN_PER_DAY = 24 * 60;

/** Trio `Duration.formattedTimeSpan(.exact)`: "45 min", "1 hr 30 min", "1 day 2 hr", "0 min". */
export function formatSpan(totalMinutes: number): string {
  const m = Math.max(0, Math.floor(totalMinutes));
  if (m === 0) return '0 min';
  const days = Math.floor(m / MIN_PER_DAY);
  const hours = Math.floor((m % MIN_PER_DAY) / 60);
  const minutes = m % 60;
  return [days ? `${days} ${days === 1 ? 'day' : 'days'}` : '', hours ? `${hours} hr` : '', minutes ? `${minutes} min` : ''].filter(Boolean).join(' ');
}

/** Trio `formattedTimeSpan(.largestTwoUnits)` for countdowns ("Starts in 1 hr 5 min", "< 1 min"). */
export function formatCountdown(ms: number): string {
  const total = ms / 60_000;
  if (total > 0 && total < 1) return `<${NBSP}1 min`;
  const m = Math.floor(total);
  if (m < MIN_PER_DAY) return formatSpan(m);
  const days = Math.floor(m / MIN_PER_DAY);
  const hours = Math.floor((m % MIN_PER_DAY) / 60);
  return [`${days} ${days === 1 ? 'day' : 'days'}`, hours ? `${hours} hr` : ''].filter(Boolean).join(' ');
}

/** `.wholePercent` as Trio renders it on the reference device: "100 %". */
export const formatPercent = (percent: number) => `${Math.round(percent)}${NBSP}%`;

/** Hour of day as a time of day ("22:00"). */
export const formatHour = (hour: number) => new Date(2000, 0, 1, hour, 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const formatGlucoseWithUnits = (mgdl: number, units: GlucoseUnit) => `${fmtG(mgdl, units)} ${units}`;

/** Trio `smbOffText`: "SMBs Off", or "SMBs Off 22:00 – 06:00" when scheduled. */
export function smbOffText(o: OverridePreset): string {
  if (!o.disableSmb && !o.smbIsScheduledOff) return '';
  if (o.disableSmb) return 'SMBs Off';
  const start = o.smbOffStartHour ?? 0;
  const end = o.smbOffEndHour ?? 0;
  if (start === 0 && end === 0) return 'SMBs Off';
  const endHour = start === end ? (start + 1) % 24 : end;
  return `SMBs Off ${formatHour(start)} – ${formatHour(endHour)}`;
}

/** Caption labels of an override preset row (AdjustmentsRootView+Overrides `overridesView`). */
export function overrideLabels(o: OverridePreset, units: GlucoseUnit, defaults: { smbMinutes: number; uamMinutes: number }): string[] {
  const duration = o.durationMin === null ? '' : formatSpan(o.durationMin);
  const inverse = o.scaleIsf && o.scaleCr ? ' ISF/CR' : o.scaleIsf ? ' ISF' : o.scaleCr ? ' CR' : '';
  const percentage = o.percentage === 100 ? '' : formatPercent(o.percentage) + inverse;
  const target = o.target ? formatGlucoseWithUnits(o.target, units) : '';
  const minutesShown = (m: number | undefined, def: number) => !!m && !!o.overrideSmbMinutes && !o.disableSmb && m !== def;
  const smb = minutesShown(o.smbMinutes, defaults.smbMinutes) ? `SMB${NBSP}${o.smbMinutes}${NBSP}min` : '';
  const uam = minutesShown(o.uamMinutes, defaults.uamMinutes) ? `UAM${NBSP}${o.uamMinutes}${NBSP}min` : '';
  return [duration, percentage, target, smbOffText(o), smb, uam].filter(Boolean);
}

/** Caption of a temp target row: "120 mg/dL for 1 hr, 75 %". */
export function tempTargetCaption(t: TempTargetPreset, units: GlucoseUnit, behavior: TargetBehavior): string {
  const base = `${formatGlucoseWithUnits(t.target, units)} for ${formatSpan(t.durationMin)}`;
  if (!isAdjustSensEnabled(t.target, behavior)) return base;
  const percentage = computeAdjustedPercentage(t.halfBasalTarget ?? behavior.halfBasalExerciseTarget, t.target, behavior.autosensMax);
  return `${base}, ${formatPercent(percentage)}`;
}
