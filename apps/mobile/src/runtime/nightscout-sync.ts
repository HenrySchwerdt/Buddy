import { createNightscoutDownloader, type NightscoutDownloader } from '@buddy/nightscout';
import { fetchedCarbToEntry, resolveDownloadedTempTarget } from './nightscout-download';
import { nightscoutAccess, uploadNightscoutProfile } from './services';
import type { ServiceHost } from './service-host';
import { useSettings } from './settings-store';

/** Download tick (Trio FetchTreatmentsManager: about once a minute) and profile upload triggers. */
export const DOWNLOAD_INTERVAL_MS = 60_000;
const PROFILE_DEBOUNCE_MS = 5_000;

let downloader: NightscoutDownloader | null = null;
let downloaderKey = '';
let busy = false;

async function getDownloader(host: ServiceHost): Promise<NightscoutDownloader | null> {
  const s = useSettings.getState();
  if (!s.nightscoutDownload) return null;
  const access = await nightscoutAccess();
  if (!access) return null;
  const key = `${access.url}|${access.token}`;
  if (!downloader || key !== downloaderKey) {
    downloaderKey = key;
    downloader = createNightscoutDownloader({
      url: access.url,
      token: access.token || undefined,
      fetch: globalThis.fetch.bind(globalThis),
      clock: { now: () => host.now() },
      log: { info: () => {}, warn: (m) => console.warn(`[nightscout] ${m}`), error: (m) => console.warn(`[nightscout] ${m}`) },
      initialState: s.nightscoutDownloadState,
    });
  }
  return downloader;
}

/** One download round: carbs go to the store, the newest running temp target becomes active, cancels end it. Never throws. */
export async function downloadFromNightscout(host: ServiceHost): Promise<void> {
  if (busy || host.isDemo()) return;
  busy = true;
  try {
    const d = await getDownloader(host).catch(() => null);
    if (!d) return;
    const snap = host.store.snapshot();
    const s = useSettings.getState();
    const known = {
      carbDates: snap.carbs.map((c) => c.date),
      knownIds: snap.carbs.map((c) => c.id),
      tempTargetDates: s.tempTarget ? [s.tempTarget.startedAt] : [],
    };
    let changed = false;
    const carbs = await d.fetchCarbs(known);
    for (const fetched of carbs.carbs) {
      const entry = fetchedCarbToEntry(fetched);
      if (entry) {
        host.store.addCarbs(entry);
        changed = true;
      }
    }
    const targets = await d.fetchTempTargets(known);
    const resolved = resolveDownloadedTempTarget(useSettings.getState().tempTarget, targets.tempTargets, targets.cancels, host.now());
    if (resolved) {
      useSettings.getState().update({ tempTarget: resolved.tempTarget });
      changed = true;
    }
    useSettings.getState().update({ nightscoutDownloadState: d.getState() as unknown as Record<string, number> });
    if (changed) void host.runLoop();
  } finally {
    busy = false;
  }
}

async function uploadProfile(host: ServiceHost): Promise<void> {
  const remote = await Promise.resolve(host.remoteProfile?.()).catch(() => null);
  await uploadNightscoutProfile(() => host.now(), remote ?? null);
}

/** Starts the download tick and the profile upload triggers; returns a stop function. */
export function startNightscoutSync(host: ServiceHost): () => void {
  const tick = setInterval(() => void downloadFromNightscout(host), DOWNLOAD_INTERVAL_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void uploadProfile(host), PROFILE_DEBOUNCE_MS);
  };
  const unsubscribe = useSettings.subscribe((s, prev) => {
    if (s.nightscoutDownload && !prev.nightscoutDownload) void downloadFromNightscout(host);
    const connected = s.nightscoutUpload && s.nightscoutUrl.length > 0;
    const justConnected = connected && !(prev.nightscoutUpload && prev.nightscoutUrl.length > 0);
    const changed = s.profile !== prev.profile || s.units !== prev.units || s.overridePresets !== prev.overridePresets || s.remoteControlEnabled !== prev.remoteControlEnabled;
    if (!connected || host.isDemo() || !(justConnected || changed)) return;
    schedule();
  });
  void downloadFromNightscout(host);
  const initial = useSettings.getState();
  if (initial.nightscoutUpload && initial.nightscoutUrl && !host.isDemo()) schedule();
  return () => {
    clearInterval(tick);
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
