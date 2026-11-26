/**
 * xDrip as a CGM source, matching Trio's "xDrip4iOS" option.
 *
 * iOS: xDrip4iOS writes its latest readings as JSON under the key `latestReadings` of the shared App Group
 * UserDefaults; Trio reads that key, and so does the native bridge here (the plugin only parses it).
 * Android: xDrip+ broadcasts `com.eveningoutpost.dexdrip.BgEstimate` locally; the native bridge buffers those.
 *
 * Rules: readings keep the time xDrip measured them (never "now"); duplicates are collapsed by timestamp;
 * readings dated more than 60 s ahead of the clock are dropped; nothing is invented, so when xDrip stops
 * delivering, the newest reading simply gets old and the loop's own staleness checks take over.
 */
import { defineCgm, type CgmSource, type DeviceContext, type DeviceMeta, type GlucoseReading, type Millis } from '@buddy/core';
import { isPlausibleGlucose } from '../trend';
import type { XdripBridge, XdripContextExtension, XdripNativeReading } from './bridge';
import { parseXdripAppGroupJson, xdripTrend } from './parse';

export type { XdripBridge, XdripContextExtension, XdripNativeReading } from './bridge';
export { parseXdripAppGroupJson, parseXdripDate, trendFromGlucoseTrendCode, xdripTrend } from './parse';

export const XDRIP_ID = 'xdrip';
/** Minimum time between native reads of the app-group data / broadcast buffer. */
export const XDRIP_MIN_POLL_MS = 30_000;
/** Readings dated further ahead of the clock than this are rejected. */
export const XDRIP_MAX_FUTURE_MS = 60_000;
/** Readings older than this are dropped from memory. */
const RETAIN_MS = 24 * 3_600_000;

const META: DeviceMeta = {
  id: XDRIP_ID,
  name: 'xDrip (xDrip4iOS / xDrip+)',
  manufacturer: 'xDrip',
  description:
    'Takes readings from the xDrip app on the same phone: xDrip4iOS through the shared App Group (as Trio does), xDrip+ through its local BgEstimate broadcast on Android. ' +
    'xDrip must stay running and connected to the sensor; Buddy does not talk to the sensor itself.',
  transport: 'native-module',
  maturity: 'experimental',
};

export const xdripCgm = defineCgm({
  meta: META,
  settings: [],
  defaultSettings: {},
  create(_settings, ctx: DeviceContext): CgmSource {
    const bridge: XdripBridge | undefined = (ctx as DeviceContext & XdripContextExtension).xdrip;
    const store = new Map<Millis, GlucoseReading>();
    let unsubscribe: (() => void) | null = null;
    let lastPollAt: Millis | null = null;
    let inFlight: Promise<void> | null = null;

    const needBridge = (): XdripBridge => {
      if (!bridge) throw new Error('xDrip: this build has no xDrip bridge (the native module is missing; needs a development build, not Expo Go).');
      return bridge;
    };

    const ingest = (raw: readonly XdripNativeReading[]): void => {
      const now = ctx.clock.now();
      for (const r of raw) {
        if (!isPlausibleGlucose(r.value) || !Number.isFinite(r.date)) continue;
        if (r.date > now + XDRIP_MAX_FUTURE_MS) {
          ctx.log.warn('xDrip: ignored a reading dated in the future');
          continue;
        }
        if (r.date < now - RETAIN_MS) continue;
        store.set(r.date, { date: r.date, value: Math.round(r.value), trend: xdripTrend(r), source: XDRIP_ID });
      }
      for (const date of store.keys()) if (date < now - RETAIN_MS) store.delete(date);
    };

    const pollNative = async (): Promise<void> => {
      const b = needBridge();
      if (b.readAppGroupJson) {
        const json = await b.readAppGroupJson();
        if (json) ingest(parseXdripAppGroupJson(json));
      }
      if (b.bufferedReadings) ingest(await b.bufferedReadings());
    };

    /** Throttled to one native read per XDRIP_MIN_POLL_MS; concurrent callers share the read. */
    const refresh = async (force: boolean): Promise<void> => {
      if (inFlight) return inFlight;
      const now = ctx.clock.now();
      if (!force && lastPollAt !== null && now - lastPollAt >= 0 && now - lastPollAt < XDRIP_MIN_POLL_MS) return;
      lastPollAt = now;
      inFlight = pollNative().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };

    return {
      meta: META,
      async start() {
        const b = needBridge();
        if (!(await b.isConfigured())) {
          throw new Error(
            b.platform === 'ios'
              ? 'xDrip: no App Group is configured. Set the appGroupId option of the xdrip config plugin to the group xDrip4iOS shares with Trio, then rebuild.'
              : 'xDrip: the xDrip+ receiver is not available in this build.',
          );
        }
        unsubscribe?.();
        unsubscribe = b.subscribe ? b.subscribe((r) => ingest([r])) : null;
        await refresh(true);
      },
      async stop() {
        unsubscribe?.();
        unsubscribe = null;
        store.clear();
        lastPollAt = null;
      },
      async readings(since) {
        await refresh(false);
        return [...store.values()].filter((r) => r.date > since).sort((a, b) => a.date - b.date);
      },
    };
  },
});
