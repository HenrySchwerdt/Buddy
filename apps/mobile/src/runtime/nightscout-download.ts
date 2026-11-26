import type { ActiveTempTarget, CarbEntry, Millis } from '@buddy/core';
import type { FetchedCarb, FetchedTempTarget } from '@buddy/nightscout';

/**
 * Pure part of Trio's FetchTreatmentsManager: how treatments entered in Nightscout change Buddy's state.
 * The network side (downloader, one-minute tick) lives in `nightscout-sync.ts`.
 */

/** Carbs as Buddy stores them (no macros, no `enteredBy`). Fat/protein-only entries yield nothing. */
export function fetchedCarbToEntry(c: FetchedCarb): CarbEntry | null {
  if (!(c.grams > 0)) return null;
  return { id: c.id, date: c.date, grams: c.grams, ...(c.absorptionHours !== undefined ? { absorptionHours: c.absorptionHours } : {}), ...(c.note ? { note: c.note } : {}) };
}

const isRunning = (t: ActiveTempTarget, now: Millis): boolean => t.startedAt <= now && now < t.startedAt + t.durationMin * 60_000;

function toActive(t: FetchedTempTarget): ActiveTempTarget {
  const { enteredBy: _enteredBy, ...rest } = t;
  return rest;
}

/**
 * The temp target Buddy should run after a download, or `undefined` when nothing changes.
 * The newest still-running remote temp target wins over an older local one; a local one that started
 * later is kept. A "Cancel" ends every temp target that started before it.
 */
export function resolveDownloadedTempTarget(
  current: ActiveTempTarget | null,
  fetched: readonly FetchedTempTarget[],
  cancels: readonly Millis[],
  now: Millis,
): { readonly tempTarget: ActiveTempTarget | null } | undefined {
  const cancelledAfter = (startedAt: Millis) => cancels.some((c) => c >= startedAt && c <= now);

  const candidate = fetched
    .filter((t) => isRunning(t, now) && !cancelledAfter(t.startedAt))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const currentCancelled = current !== null && cancelledAfter(current.startedAt);

  const keep = current !== null && !currentCancelled ? current : null;
  if (candidate && (!keep || candidate.startedAt > keep.startedAt)) {
    if (current && current.id === candidate.id) return undefined;
    return { tempTarget: toActive(candidate) };
  }
  if (currentCancelled) return { tempTarget: null };
  return undefined;
}
