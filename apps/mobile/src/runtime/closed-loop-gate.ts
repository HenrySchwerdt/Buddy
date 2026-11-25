import type { DeviceMeta } from '@buddy/core';

type GateMeta = Pick<DeviceMeta, 'id' | 'name' | 'maturity'> & { readonly readOnly?: boolean; readonly requiresHardwareCheck?: boolean };

/**
 * Why closed loop must stay off for this device pairing, or null when it may run.
 * Pure so it can be tested without the runtime; the order of checks is the order of severity.
 */
export function closedLoopBlockReason(pump: GateMeta | undefined, cgm: GateMeta | undefined, hardwareChecks: Readonly<Record<string, unknown>>): string | null {
  if (!pump || !cgm) return 'No pump or CGM configured.';
  if (pump.readOnly) return 'Shadow mode: Buddy follows your running loop and only suggests. It never doses.';
  const pumpSimulated = pump.maturity === 'simulator';
  const cgmSimulated = cgm.maturity === 'simulator';
  if (pumpSimulated && !cgmSimulated) return 'Closed loop needs pump and CGM from the same world: a demo pump cannot dose against real glucose.';
  if (!pumpSimulated && cgmSimulated) return 'Closed loop needs pump and CGM from the same world: a real pump must never dose against simulated glucose.';
  if (pump.requiresHardwareCheck && !hardwareChecks[pump.id])
    return `${pump.name} is an experimental driver. Complete the hardware check (pump not attached to your body) to enable closed loop.`;
  return null;
}
