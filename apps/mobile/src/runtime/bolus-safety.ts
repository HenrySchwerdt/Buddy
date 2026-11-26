import { computeIob, validateBolusSafety, type BolusSafetyResult, type InsulinDose, type Millis, type SafetyLimits, type TherapyProfile } from '@buddy/core';

/**
 * Wires the pure Trio `BolusSafetyValidator` port (`@buddy/core` safety.ts) to Buddy's data:
 * IOB is computed from the stored doses right now (so its date is `now` and never stale), and every
 * bolus/SMB/external dose counts for the recent-bolus rule. Used for manual and remote boluses,
 * never for loop SMBs (those have their own SafetyGuard limits).
 */
export interface BolusSafetyCheck {
  readonly units: number;
  readonly limits: Pick<SafetyLimits, 'maxBolus' | 'maxIOB'>;
  readonly profile: TherapyProfile;
  readonly doses: readonly InsulinDose[];
  readonly now: Millis;
  readonly source?: 'app' | 'remote';
  /** Remote commands pass the command timestamp so any bolus since it was sent counts. */
  readonly lookbackStart?: Millis;
}

export function checkBolusSafety(c: BolusSafetyCheck): BolusSafetyResult {
  const iob = computeIob(c.doses, c.profile, c.now);
  const recentBoluses = c.doses.flatMap((d) => (d.kind === 'bolus' || d.kind === 'smb' ? [{ date: d.date, units: d.units }] : []));
  return validateBolusSafety({
    units: c.units,
    maxBolus: c.limits.maxBolus,
    maxIOB: c.limits.maxIOB,
    currentIOB: iob.iob,
    iobDate: iob.date,
    recentBoluses,
    now: c.now,
    ...(c.source ? { source: c.source } : {}),
    ...(c.lookbackStart !== undefined ? { lookbackStart: c.lookbackStart } : {}),
  });
}
