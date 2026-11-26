import type { InsulinDose, Millis, PumpDriver } from '@buddy/core';

/** Home's bolus progress bar (`useBolusTracker`) as the runtime sees it. */
export interface BolusTracker {
  begin(total: number): void;
  setDelivered(delivered: number): void;
  end(): void;
}

export const BOLUS_POLL_MS = 2_000;

/** Units of pump-delivered boluses (not external insulin) that started at or after `since`, capped at the requested total. */
export function deliveredSince(doses: readonly InsulinDose[], since: Millis, total: number): number {
  const sum = doses.reduce((s, d) => (d.kind === 'bolus' && d.external !== true && d.date >= since ? s + d.units : s), 0);
  return Math.min(total, Math.round(sum * 1000) / 1000);
}

/**
 * Runs `deliver` while publishing progress: `begin(total)` first, then every few seconds the units the pump
 * history already shows, and `end()` when done (also when it fails). Progress polling never throws into the bolus.
 */
export async function withBolusProgress<T>(
  tracker: BolusTracker,
  pump: Pick<PumpDriver, 'history'>,
  total: number,
  now: () => Millis,
  deliver: () => Promise<T>,
  pollMs = BOLUS_POLL_MS,
): Promise<T> {
  const startedAt = now();
  tracker.begin(total);
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    pump
      .history(startedAt)
      .then((doses) => tracker.setDelivered(deliveredSince(doses, startedAt, total)))
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, pollMs);
  try {
    const result = await deliver();
    tracker.setDelivered(total);
    return result;
  } finally {
    clearInterval(timer);
    tracker.end();
  }
}

/**
 * Lets one manual or remote bolus run at a time. The safety rules (recent boluses, max IOB) only see a bolus once it is in
 * the store, so two overlapping requests (double tap, remote command plus tap) would both pass them. The second one fails.
 */
export function createBolusGate(): <T>(run: () => Promise<T>) => Promise<T> {
  let busy = false;
  return async (run) => {
    if (busy) throw new Error('Another bolus is still being delivered.');
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  };
}

/**
 * After the pump accepted a bolus: store what the pump history shows. If the history cannot be read, the delivered bolus is still
 * stored (provisional record), so IOB and the recent-bolus rule know about it and a retry cannot stack another bolus on top.
 * Never throws: the insulin was delivered.
 */
export async function recordDeliveredBolus(
  store: { addDoses(doses: readonly InsulinDose[]): void },
  pump: Pick<PumpDriver, 'history'>,
  units: number,
  startedAt: Millis,
  now: () => Millis,
  provisionalId: string,
): Promise<void> {
  try {
    store.addDoses(await pump.history(now() - 60 * 60_000));
  } catch {
    store.addDoses([{ kind: 'bolus', date: startedAt, units, id: provisionalId }]);
  }
}
