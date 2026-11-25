import type { LoopMode } from '@buddy/core';
import type { Hint } from './components/hint-sheet';

/**
 * Trio's DosingMode (Models/DosingMode.swift) reduced to the two modes Buddy's loop
 * engine has. Low Glucose Suspend and Basal Testing have no Buddy equivalent.
 */
export const DOSING_MODES: readonly { value: LoopMode; label: string }[] = [
  { value: 'closed', label: 'Closed Loop' },
  { value: 'open', label: 'Open Loop' },
];

const MINI_HINT: Record<LoopMode, string> = {
  closed: 'Buddy adjusts your insulin automatically.',
  open: 'Buddy only shows what it would do. It never changes your insulin.',
};

/** Trio shows why AID is unavailable instead of the mode hint; Buddy shows closedLoopBlocked. */
export function dosingModeMiniHint(mode: LoopMode, blocked: string | null): string {
  return blocked ?? MINI_HINT[mode];
}

export const DOSING_MODE_HINT: Hint = {
  label: 'Dosing Mode',
  lines: [
    "Dosing Mode decides how much of Trio's insulin dosing decision is actually sent to your pump. Every mode still needs an active CGM sensor session and a connected pump.",
    '**Closed Loop',
    'Trio checks your glucose every five minutes and changes your insulin for you. You need a working CGM and a connected pump.',
    '**Open Loop',
    'Trio still shows what it would do, but it never changes your insulin. Your pump keeps running the basal rates you set, and every dose is your choice. Trio is running in manual mode. It will not stop a low or fix a high for you.',
  ],
};
