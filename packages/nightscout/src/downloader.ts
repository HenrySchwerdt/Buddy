import { MGDL_PER_MMOLL, type ActiveTempTarget, type CarbEntry, type Clock, type Logger, type Millis } from '@buddy/core';
import { ENTERED_BY } from './format';
import { buildHeaders, buildUrl, errorText, normalizeBaseUrl, type NightscoutAuth } from './http';
import type { CarbMacros } from './treatments';

const TREATMENTS_PATH = '/api/v1/treatments.json';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Trio's `syncDate()`: carbs and temp targets are only fetched for the last day. */
export const FETCH_LOOKBACK_MS = DAY;
/** Nightscout returns 10 treatments unless asked for more; Trio does not ask, Buddy does. */
const FETCH_COUNT = 500;
/** Id prefix for everything read from Nightscout; the uploader skips `ns-` ids so nothing loops back. */
export const FETCHED_ID_PREFIX = 'ns-';
/** Trio's `TempTarget.cancel`. */
const CANCEL_REASON = 'Cancel';

/**
 * Trio's `NightscoutAPI.excludedEnteredBy` (its own name, AAPS, iAPS, Loop) plus Buddy's own name:
 * only data entered elsewhere (Nightscout care portal, other followers' manual entries, ...) is fetched.
 */
export const EXCLUDED_ENTERED_BY: readonly string[] = [ENTERED_BY, 'Trio', 'AndroidAPS', 'openaps://AndroidAPS', 'iAPS', 'loop://iPhone'];

export type FetchedCarb = CarbEntry & CarbMacros & { readonly enteredBy?: string };

export interface FetchedTempTarget extends ActiveTempTarget {
  readonly enteredBy?: string;
}

export interface DownloaderState {
  /** Newest `created_at` seen per collection (epoch ms). Persist these. */
  readonly carbs: Millis;
  readonly tempTargets: Millis;
}
export const EMPTY_DOWNLOADER_STATE: DownloaderState = { carbs: 0, tempTargets: 0 };

/** What Buddy already stores, so remote duplicates are dropped (Trio `filterRemoteEntries` / `existsTempTarget`). */
export interface KnownLocal {
  /** Dates of locally stored carb entries (last 24 h is enough). */
  readonly carbDates?: readonly Millis[];
  /** Start times of locally stored temp targets. */
  readonly tempTargetDates?: readonly Millis[];
  /** Nightscout `_id`s (or Buddy ids) already imported. */
  readonly knownIds?: readonly string[];
}

export interface FetchCarbsResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly carbs: readonly FetchedCarb[];
}

export interface FetchTempTargetsResult {
  readonly ok: boolean;
  readonly error?: string;
  /** New temp targets, oldest first. Cancels are not included (Trio skips them on store). */
  readonly tempTargets: readonly FetchedTempTarget[];
  /** Start times of "Cancel" temp targets: end any running temp target at these times. */
  readonly cancels: readonly Millis[];
}

export interface NightscoutDownloaderConfig extends NightscoutAuth {
  /** Site URL (https only). Empty = downloading disabled. */
  readonly url: string;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly log: Logger;
  readonly initialState?: Partial<DownloaderState>;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** ISO string or epoch ms -> epoch ms. */
function parseDate(v: unknown): Millis | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

const isExcluded = (enteredBy: string | undefined): boolean => enteredBy !== undefined && EXCLUDED_ENTERED_BY.includes(enteredBy);
const idOf = (doc: Json): string | undefined => str(doc._id) ?? str(doc.identifier) ?? str(doc.id);

/**
 * Mongo `$ne` also matches documents without the field; a stray Buddy/Trio document that slipped
 * through (older Nightscout, cached response) is dropped here too. Treatments carrying Buddy's
 * own record ids (`ns-` ids are Buddy imports, others are Buddy uploads) are never re-imported.
 */
function isOwn(doc: Json): boolean {
  if (isExcluded(str(doc.enteredBy))) return true;
  const own = str(doc.identifier) ?? str(doc.id);
  return own !== undefined && own.startsWith(FETCHED_ID_PREFIX);
}

/** Maps one Nightscout carb treatment; null when it is not a usable carb entry. */
export function mapNightscoutCarb(doc: Json): FetchedCarb | null {
  const createdAt = parseDate(doc.created_at);
  const id = idOf(doc);
  if (createdAt === undefined || !id) return null;
  const grams = num(doc.carbs) ?? 0;
  const fat = num(doc.fat);
  const protein = num(doc.protein);
  // Trio stores fat/protein-only entries too (they become carb equivalents).
  if (grams <= 0 && !((fat ?? 0) > 0 || (protein ?? 0) > 0)) return null;
  if (doc.isFPU === true) return null; // a carb-equivalent row of another app's meal, not a meal
  const absorption = num(doc.absorptionTime);
  const note = str(doc.notes);
  const enteredBy = str(doc.enteredBy);
  return {
    id: `${FETCHED_ID_PREFIX}carb-${id}`,
    // Trio dedupes on `actualDate ?? created_at`, so that is the meal time.
    date: parseDate(doc.actualDate) ?? createdAt,
    grams,
    ...(fat !== undefined && fat > 0 ? { fat } : {}),
    ...(protein !== undefined && protein > 0 ? { protein } : {}),
    ...(absorption !== undefined && absorption > 0 ? { absorptionHours: absorption / 60 } : {}),
    ...(note ? { note } : {}),
    ...(enteredBy ? { enteredBy } : {}),
  };
}

/** Maps one Nightscout `Temporary Target`; cancels yield `{ cancel: startedAt }`. */
export function mapNightscoutTempTarget(doc: Json): FetchedTempTarget | { readonly cancel: Millis } | null {
  const startedAt = parseDate(doc.created_at);
  const id = idOf(doc);
  const duration = num(doc.duration);
  if (startedAt === undefined || !id || duration === undefined) return null;
  const reason = str(doc.reason);
  const name = str(doc.name) ?? reason ?? str(doc.notes) ?? 'Temp Target';
  if (reason === CANCEL_REASON || name === CANCEL_REASON || duration <= 0) return { cancel: startedAt };

  const unitScale = /mmol/i.test(str(doc.units) ?? '') ? MGDL_PER_MMOLL : 1;
  const top = num(doc.targetTop);
  const bottom = num(doc.targetBottom);
  const bounds = [top, bottom].filter((v): v is number => v !== undefined && v > 0);
  if (bounds.length === 0) return null;
  const target = Math.round((bounds.reduce((a, b) => a + b, 0) / bounds.length) * unitScale);
  const half = num(doc.halfBasalTarget);
  const enteredBy = str(doc.enteredBy);
  return {
    id: `${FETCHED_ID_PREFIX}tt-${id}`,
    name,
    target,
    durationMin: Math.round(duration),
    startedAt,
    ...(half !== undefined && half > 0 ? { halfBasalTarget: half } : {}),
    ...(enteredBy ? { enteredBy } : {}),
  };
}

/**
 * Reads carbs and temp targets entered in Nightscout (not by Buddy, Trio, AAPS, iAPS or Loop),
 * like Trio's FetchTreatmentsManager. Never throws; failures are reported in the result and
 * the high-water mark only advances after a successful fetch.
 */
export function createNightscoutDownloader(config: NightscoutDownloaderConfig) {
  let state: DownloaderState = {
    carbs: Math.max(0, config.initialState?.carbs ?? 0),
    tempTargets: Math.max(0, config.initialState?.tempTargets ?? 0),
  };

  /** Trio always looks back one day; the mark only narrows that window. */
  const sinceOf = (mark: Millis): Millis => Math.max(mark, config.clock.now() - FETCH_LOOKBACK_MS);

  async function get(params: readonly (readonly [string, string])[]): Promise<Json[]> {
    const base = normalizeBaseUrl(config.url);
    const exclusions = EXCLUDED_ENTERED_BY.map((v, i) => [`find[$and][${i}][enteredBy][$ne]`, v] as const);
    const url = buildUrl(base, TREATMENTS_PATH, config, [...params, ...exclusions, ['count', String(FETCH_COUNT)]]);
    const res = await config.fetch(url, { method: 'GET', headers: buildHeaders(config, false) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('unexpected response');
    return body.filter((d): d is Json => typeof d === 'object' && d !== null);
  }

  const sinceParam = (since: Millis) => ['find[created_at][$gt]', new Date(since).toISOString()] as const;

  return {
    async fetchCarbs(known: KnownLocal = {}): Promise<FetchCarbsResult> {
      if (!config.url.trim()) return { ok: true, carbs: [] };
      try {
        const docs = await get([['find[carbs][$exists]', 'true'], sinceParam(sinceOf(state.carbs))]);
        const seenDates = new Set(known.carbDates ?? []);
        const seenIds = new Set(known.knownIds ?? []);
        const out: FetchedCarb[] = [];
        let newest = state.carbs;
        for (const doc of docs) {
          const created = parseDate(doc.created_at);
          if (created !== undefined) newest = Math.max(newest, created);
          if (isOwn(doc)) continue;
          const carb = mapNightscoutCarb(doc);
          if (!carb || seenIds.has(carb.id) || seenIds.has(idOf(doc) ?? '') || seenDates.has(carb.date)) continue;
          seenDates.add(carb.date);
          seenIds.add(carb.id);
          out.push(carb);
        }
        state = { ...state, carbs: newest };
        if (out.length > 0) config.log.info(`Nightscout: fetched ${out.length} carb entries`);
        return { ok: true, carbs: out.sort((a, b) => a.date - b.date) };
      } catch (e) {
        const error = `Nightscout carbs fetch failed: ${errorText(e)}`;
        config.log.warn(error);
        return { ok: false, error, carbs: [] };
      }
    },

    async fetchTempTargets(known: KnownLocal = {}): Promise<FetchTempTargetsResult> {
      if (!config.url.trim()) return { ok: true, tempTargets: [], cancels: [] };
      try {
        // `Temporary+Target` is a form-encoded space, exactly what URLSearchParams produces.
        const docs = await get([['find[eventType]', 'Temporary Target'], ['find[duration][$exists]', 'true'], sinceParam(sinceOf(state.tempTargets))]);
        const seenDates = new Set(known.tempTargetDates ?? []);
        const seenIds = new Set(known.knownIds ?? []);
        const targets: FetchedTempTarget[] = [];
        const cancels: Millis[] = [];
        let newest = state.tempTargets;
        for (const doc of docs) {
          const created = parseDate(doc.created_at);
          if (created !== undefined) newest = Math.max(newest, created);
          if (isOwn(doc)) continue;
          const mapped = mapNightscoutTempTarget(doc);
          if (!mapped) continue;
          if ('cancel' in mapped) {
            cancels.push(mapped.cancel);
            continue;
          }
          if (seenIds.has(mapped.id) || seenIds.has(idOf(doc) ?? '') || seenDates.has(mapped.startedAt)) continue;
          seenDates.add(mapped.startedAt);
          seenIds.add(mapped.id);
          targets.push(mapped);
        }
        state = { ...state, tempTargets: newest };
        if (targets.length > 0) config.log.info(`Nightscout: fetched ${targets.length} temp targets`);
        return { ok: true, tempTargets: targets.sort((a, b) => a.startedAt - b.startedAt), cancels: cancels.sort((a, b) => a - b) };
      } catch (e) {
        const error = `Nightscout temp targets fetch failed: ${errorText(e)}`;
        config.log.warn(error);
        return { ok: false, error, tempTargets: [], cancels: [] };
      }
    },

    getState: (): DownloaderState => state,
    setState(next: Partial<DownloaderState>): void {
      state = { carbs: next.carbs ?? state.carbs, tempTargets: next.tempTargets ?? state.tempTargets };
    },
  };
}

export type NightscoutDownloader = ReturnType<typeof createNightscoutDownloader>;
