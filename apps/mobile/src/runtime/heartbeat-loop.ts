import type { CgmSource, DataSnapshot, Logger, PumpDriver } from '@buddy/core';
import { heartbeatLoopDue } from './heartbeat-policy';
import type { TaskGuard } from './task-guard';

/**
 * Bluetooth heartbeat -> loop, the way Trio does it (`DeviceDataManager.heartbeat` -> `recommendsLoop` -> `loop()`):
 * the app is woken by Bluetooth (a CGM reading, a pump notification, a heartbeat transmitter), not by a timer, and
 * every wake runs inside a background task so the cycle can finish before iOS suspends the app again.
 *
 * Sources, as in Trio: a CGM that has its own BLE heartbeat is the heartbeat (the pump is then relieved of it,
 * `pumpManagerMustProvideBLEHeartbeat`); otherwise the pump's and the heartbeat transmitter's are used.
 */
export interface HeartbeatLoopDeps {
  readonly cgm: CgmSource | null;
  readonly pump: PumpDriver | null;
  /** Subscribes to the heartbeat transmitter; used only when the CGM provides no heartbeat. */
  readonly onTransmitterHeartbeat: (listener: () => void) => () => void;
  readonly snapshot: () => DataSnapshot;
  readonly now: () => number;
  readonly isLooping: () => boolean;
  readonly runLoop: () => Promise<unknown>;
  /** Resolves when the work a loop cycle leaves behind (alerts, uploads) is done. */
  readonly afterLoopSettled: () => Promise<void>;
  readonly tasks: TaskGuard;
  readonly log: Logger;
}

export const HEARTBEAT_TASK_NAME = 'buddy-heartbeat-loop';

/** Which heartbeat sources feed the loop with these devices. */
export function heartbeatSources(deps: Pick<HeartbeatLoopDeps, 'cgm' | 'pump' | 'onTransmitterHeartbeat'>): { readonly name: string; readonly subscribe: (l: () => void) => () => void }[] {
  const { cgm, pump } = deps;
  if (cgm?.onHeartbeat) return [{ name: 'cgm', subscribe: (l) => cgm.onHeartbeat!(l) }];
  const sources: { name: string; subscribe: (l: () => void) => () => void }[] = [];
  if (pump?.onHeartbeat) sources.push({ name: 'pump', subscribe: (l) => pump.onHeartbeat!(l) });
  sources.push({ name: 'transmitter', subscribe: deps.onTransmitterHeartbeat });
  return sources;
}

/** Starts listening; returns the function that stops it. */
export function startHeartbeatLoop(deps: HeartbeatLoopDeps): () => void {
  let active = true;
  let busy = false;
  let again = false;

  async function evaluate(): Promise<void> {
    const snap = deps.snapshot();
    const newestStored = snap.glucose.at(-1)?.date ?? 0;
    // `readings(since)` only returns what is newer than `since`: anything it returns the last run has not seen.
    // Only a BLE CGM is asked (it answers from memory); cloud sources would hit the network on every wake.
    const hasUnseenReading = deps.cgm?.onHeartbeat ? (await deps.cgm.readings(newestStored)).length > 0 : false;
    const due = heartbeatLoopDue({ now: deps.now(), lastRunAt: snap.loopRuns.at(-1)?.date ?? 0, hasUnseenReading, looping: deps.isLooping() });
    if (!due) return;
    await deps.runLoop();
    await deps.afterLoopSettled();
  }

  /** A heartbeat that arrives while one is handled is not lost: it triggers one more evaluation afterwards. */
  async function onHeartbeat(): Promise<void> {
    if (!active) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await deps.tasks.run(HEARTBEAT_TASK_NAME, async () => {
        do {
          again = false;
          try {
            await evaluate();
          } catch (e) {
            deps.log.warn(`Heartbeat loop failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } while (again && active);
      });
    } finally {
      busy = false;
    }
  }

  const unsubscribers = heartbeatSources(deps).map((s) => s.subscribe(() => void onHeartbeat()));
  return () => {
    active = false;
    for (const off of unsubscribers) off();
  };
}
