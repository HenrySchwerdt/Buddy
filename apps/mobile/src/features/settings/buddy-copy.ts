import { DEFAULT_LIMITS } from '@buddy/core';
import type { TrioSettingCopy } from './types';

const GUARD =
  "Buddy's SafetyGuard enforces this after every algorithm decision, independent of which algorithm is active.";

/** Copy for Buddy SafetyGuard limits (no Trio equivalent), written in Trio's hint style. */
export const BUDDY_LIMIT_COPY = {
  maxAutoBolus: {
    label: 'Maximum Automatic Bolus',
    miniHint: 'Largest single automatic (micro)bolus allowed.',
    header: 'Buddy Safety Guard',
    hint: [`**Default: ${DEFAULT_LIMITS.maxAutoBolus} units`, 'Caps every automatic bolus (SMB) an algorithm requests. Manual boluses are limited by Maximum Bolus instead.', GUARD],
  },
  suspendThreshold: {
    label: 'Suspend Threshold',
    miniHint: 'Zero temp and no automatic insulin at or heading below this.',
    hint: [
      `**Default: {g:${DEFAULT_LIMITS.suspendThreshold}} {unit}`,
      'When glucose is at or forecast below this value, Buddy sets a zero temp basal and never adds automatic insulin.',
      GUARD,
    ],
  },
  maxGlucoseAgeMinutes: {
    label: 'Maximum CGM Data Age',
    miniHint: 'Older glucose data stops automatic dosing.',
    hint: [`**Default: ${DEFAULT_LIMITS.maxGlucoseAgeMinutes} minutes`, 'If the newest CGM reading is older than this, Buddy does not dose automatically until fresh data arrives.', GUARD],
  },
  minAutoBolusIntervalMinutes: {
    label: 'Minimum Automatic Bolus Interval',
    miniHint: 'Minimum time between two automatic boluses.',
    hint: [`**Default: ${DEFAULT_LIMITS.minAutoBolusIntervalMinutes} minutes`, 'Automatic boluses closer together than this are dropped.', GUARD],
  },
} as const satisfies Record<string, TrioSettingCopy>;
