import type { InsulinDose } from '@buddy/core';

/**
 * Pure parts of the experimental-driver hardware check (bench verification, pump not worn).
 * The UI lives in hardware-check.tsx.
 */

export type HardwareStepId = 'status' | 'tempBasal' | 'bolus' | 'suspend' | 'linkDrop';

export interface HardwareStep {
  readonly id: HardwareStepId;
  readonly title: string;
  readonly instruction: string;
}

export const HARDWARE_STEPS: readonly HardwareStep[] = [
  {
    id: 'status',
    title: 'Read Pump Status',
    instruction: 'Buddy reads reservoir, battery and delivery state. Compare every value with the pump display.',
  },
  {
    id: 'tempBasal',
    title: 'Temporary Basal',
    instruction: 'Buddy sets a 30-minute temporary basal, then cancels it. Confirm each change on the pump display.',
  },
  {
    id: 'bolus',
    title: '0.1 U Bolus',
    instruction: 'Buddy delivers 0.1 U and compares it with the pump history. Check the pump history on the pump itself.',
  },
  {
    id: 'suspend',
    title: 'Suspend and Resume',
    instruction: 'Buddy suspends delivery, then resumes it. Confirm each state on the pump display.',
  },
  {
    id: 'linkDrop',
    title: 'Link Drop During a Bolus',
    instruction:
      'Buddy starts a bolus. While it runs, turn off Bluetooth on this iPhone (Control Center) and turn it back on after 30 seconds. Buddy must then report exactly what the pump history shows.',
  },
];

/** Test temp basal: 50 % of the scheduled rate, at least one increment, never above max basal. */
export function testTempBasalRate(scheduledRate: number, maxBasalRate: number, increment: number): number {
  const step = increment > 0 ? increment : 0.05;
  const half = Math.floor(scheduledRate / 2 / step + 1e-9) * step;
  const rate = Math.min(Math.max(half, step), maxBasalRate);
  return Math.round(rate * 1000) / 1000;
}

/** Bolus size for the link-drop step: long enough to interrupt (≈ 0.5 U), within max bolus. */
export function linkDropBolus(maxBolus: number, increment: number): number {
  const step = increment > 0 ? increment : 0.05;
  const units = Math.min(0.5, maxBolus);
  return Math.round(Math.floor(units / step + 1e-9) * step * 1000) / 1000;
}

/** Sum of bolus/SMB units the driver reports as delivered at or after `since`. */
export function deliveredBolusSince(history: readonly InsulinDose[], since: number): number {
  const total = history.filter((d) => (d.kind === 'bolus' || d.kind === 'smb') && d.date >= since).reduce((sum, d) => sum + (d.kind === 'bolus' || d.kind === 'smb' ? d.units : 0), 0);
  return Math.round(total * 1000) / 1000;
}

/** True when the reported amount equals the expected one within half an increment. */
export function bolusMatches(reported: number, expected: number, increment: number): boolean {
  return Math.abs(reported - expected) <= (increment > 0 ? increment : 0.05) / 2;
}
