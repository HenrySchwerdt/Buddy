import type { DeviceMeta } from '@buddy/core';

type GateMeta = Pick<DeviceMeta, 'id' | 'name' | 'maturity'> & { readonly readOnly?: boolean };

/**
 * Why closed loop must stay off for this device pairing, or null when it may run.
 * Matches Trio: any configured pump and CGM may loop. The only additions are that a read-only
 * follower cannot dose and a real pump never doses against simulated glucose.
 */
export function closedLoopBlockReason(pump: GateMeta | undefined, cgm: GateMeta | undefined): string | null {
  if (!pump || !cgm) return 'No pump or CGM configured.';
  if (pump.readOnly) return 'Shadow mode: Buddy follows your running loop and only suggests. It never doses.';
  if (pump.maturity !== 'simulator' && cgm.maturity === 'simulator') return 'A real pump must never dose against simulated glucose. Choose a real CGM to enable closed loop.';
  return null;
}
