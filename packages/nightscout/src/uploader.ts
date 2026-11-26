import type { ActiveOverride, ActiveTempTarget, CarbEntry, Clock, GlucoseReading, InsulinDose, Logger, LoopRun, Millis, PumpState } from '@buddy/core';
import { mapLoopRunToDeviceStatus } from './devicestatus';
import { buildHeaders, buildUrl, errorText, hashApiSecret, normalizeBaseUrl } from './http';
import { mapGlucoseToEntries } from './entries';
import { mapProfileToStore, type ProfileUploadInput } from './profile';
import { mapCarbsToTreatments, mapDosesToTreatments, mapNoteToTreatment, mapOverrideToTreatment, mapSensorStartsToTreatments, mapTempTargetToTreatment, type CarbMacros, type SensorSession } from './treatments';
import type { DeviceStatusOptions } from './types';

/** Nightscout and Trio both cap uploads at 100 documents per request. */
export const MAX_BATCH = 100;

const PATHS = {
  entries: '/api/v1/entries.json',
  treatments: '/api/v1/treatments.json',
  devicestatus: '/api/v1/devicestatus.json',
  profile: '/api/v1/profile.json',
} as const;

export const COLLECTIONS = ['entries', 'doses', 'carbs', 'tempTargets', 'overrides', 'sensors', 'deviceStatus'] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** Per-collection high-water marks (epoch ms of the newest uploaded item). Persist these. */
export type UploaderState = Readonly<Record<Collection, Millis>>;

export type CollectionResult = { readonly ok: true; readonly uploaded: number } | { readonly ok: false; readonly uploaded: number; readonly error: string };

/** Outcome of a one-off request (profile, note, deletion). `skipped` = no URL configured, nothing was sent. */
export type ActionResult = { readonly ok: true; readonly skipped: boolean } | { readonly ok: false; readonly error: string };

export interface UploadResult {
  /** True when nothing was attempted because no URL is configured. */
  readonly skipped: boolean;
  readonly collections: Readonly<Record<Collection, CollectionResult>>;
}

export interface UploadSnapshot {
  readonly glucose: readonly GlucoseReading[];
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly (CarbEntry & CarbMacros)[];
  readonly loopRuns: readonly LoopRun[];
  readonly pump: PumpState | null;
  readonly tempTargets?: readonly ActiveTempTarget[];
  readonly overrides?: readonly ActiveOverride[];
  /** CGM sensor session starts, uploaded as `Sensor Start` treatments (Trio's CGM state notes). */
  readonly sensors?: readonly SensorSession[];
  readonly uploader?: DeviceStatusOptions;
}

export interface NightscoutUploaderConfig {
  /** Site URL (https only). Empty = uploading disabled. */
  readonly url: string;
  /** Access token with write permission, sent as `?token=`. */
  readonly token?: string;
  /** API secret, sent as `api-secret: sha1(secret)` like Trio. */
  readonly apiSecret?: string;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly log: Logger;
  readonly initialState?: Partial<UploaderState>;
}

export const EMPTY_STATE: UploaderState = { entries: 0, doses: 0, carbs: 0, tempTargets: 0, overrides: 0, sensors: 0, deviceStatus: 0 };

export { hashApiSecret };

interface Pending {
  readonly date: Millis;
  readonly doc: unknown;
}

function sanitizeState(s: Partial<UploaderState> | undefined): UploaderState {
  const out: Record<Collection, Millis> = { ...EMPTY_STATE };
  for (const c of COLLECTIONS) {
    const v = s?.[c];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[c] = v;
  }
  return out;
}

/**
 * Uploads Buddy data to Nightscout the way Trio does. Each collection only sends items newer
 * than its high-water mark; the mark advances per successful batch, so a failure part-way
 * resumes where it stopped. Never throws: every failure is reported in the result.
 */
export function createNightscoutUploader(config: NightscoutUploaderConfig) {
  let state = sanitizeState(config.initialState);
  let inFlight: Promise<UploadResult> | null = null;

  function request(base: string, path: string, body: unknown): Promise<Response> {
    return config.fetch(buildUrl(base, path, config), { method: 'POST', headers: buildHeaders(config, true), body: JSON.stringify(body) });
  }

  /** Resolves the configured base URL, or why there is none. */
  function target(): { readonly base: string } | { readonly skipped: true } | { readonly error: string } {
    if (!config.url.trim()) return { skipped: true };
    try {
      return { base: normalizeBaseUrl(config.url) };
    } catch (e) {
      return { error: errorText(e) };
    }
  }

  async function perform(what: string, call: (base: string) => Promise<Response>): Promise<ActionResult> {
    const t = target();
    if ('skipped' in t) return { ok: true, skipped: true };
    if ('error' in t) return { ok: false, error: t.error };
    try {
      const res = await call(t.base);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      config.log.info(`Nightscout: ${what}`);
      return { ok: true, skipped: false };
    } catch (e) {
      const error = `Nightscout ${what} failed: ${errorText(e)}`;
      config.log.warn(error);
      return { ok: false, error };
    }
  }

  const remove = (path: string, params: readonly (readonly [string, string])[]) => (base: string) =>
    config.fetch(buildUrl(base, path, config, params), { method: 'DELETE', headers: buildHeaders(config, false) });

  async function send(base: string, collection: Collection, path: string, items: readonly Pending[]): Promise<CollectionResult> {
    const now = config.clock.now();
    const pending = items.filter((p) => p.date > state[collection] && p.date <= now).sort((a, b) => a.date - b.date);
    let uploaded = 0;
    for (let i = 0; i < pending.length; i += MAX_BATCH) {
      const batch = pending.slice(i, i + MAX_BATCH);
      try {
        const res = await request(base, path, batch.map((p) => p.doc));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        const error = `Nightscout ${collection} upload failed: ${errorText(e)}`;
        config.log.warn(error);
        return { ok: false, uploaded, error };
      }
      uploaded += batch.length;
      // If the next batch starts at the same millisecond, stay just below it so a failure there
      // cannot skip it; a re-sent duplicate is harmless, a lost treatment is not.
      const last = batch.at(-1)!.date;
      const next = pending[i + MAX_BATCH];
      state = { ...state, [collection]: next && next.date === last ? last - 1 : last };
    }
    if (uploaded > 0) config.log.info(`Nightscout: uploaded ${uploaded} ${collection}`);
    return { ok: true, uploaded };
  }

  const treatmentsOf = (docs: readonly { created_at: string }[]): Pending[] => docs.map((doc) => ({ date: Date.parse(doc.created_at), doc }));

  async function run(snapshot: UploadSnapshot): Promise<UploadResult> {
    const idle: CollectionResult = { ok: true, uploaded: 0 };
    if (!config.url.trim()) {
      return { skipped: true, collections: Object.fromEntries(COLLECTIONS.map((c) => [c, idle])) as Record<Collection, CollectionResult> };
    }
    let base: string;
    try {
      base = normalizeBaseUrl(config.url);
    } catch (e) {
      const failed: CollectionResult = { ok: false, uploaded: 0, error: errorText(e) };
      return { skipped: false, collections: Object.fromEntries(COLLECTIONS.map((c) => [c, failed])) as Record<Collection, CollectionResult> };
    }

    const latestRun = snapshot.loopRuns.reduce<LoopRun | null>((best, r) => (!best || r.date > best.date ? r : best), null);
    // Only the newest loop run is uploaded (like Trio): devicestatus carries the *current* pump state.
    const statuses: Pending[] = latestRun ? [{ date: latestRun.date, doc: mapLoopRunToDeviceStatus(latestRun, snapshot.pump, snapshot.uploader) }] : [];

    return {
      skipped: false,
      collections: {
        entries: await send(base, 'entries', PATHS.entries, mapGlucoseToEntries(snapshot.glucose).map((doc) => ({ date: doc.date, doc }))),
        doses: await send(base, 'doses', PATHS.treatments, treatmentsOf(mapDosesToTreatments(snapshot.doses))),
        carbs: await send(base, 'carbs', PATHS.treatments, treatmentsOf(mapCarbsToTreatments(snapshot.carbs))),
        tempTargets: await send(base, 'tempTargets', PATHS.treatments, treatmentsOf((snapshot.tempTargets ?? []).map(mapTempTargetToTreatment))),
        overrides: await send(base, 'overrides', PATHS.treatments, treatmentsOf((snapshot.overrides ?? []).map(mapOverrideToTreatment))),
        sensors: await send(base, 'sensors', PATHS.treatments, treatmentsOf(mapSensorStartsToTreatments(snapshot.sensors ?? []))),
        deviceStatus: await send(base, 'deviceStatus', PATHS.devicestatus, statuses),
      },
    };
  }

  return {
    /** Concurrent calls share the running upload so nothing is sent twice. */
    upload(snapshot: UploadSnapshot): Promise<UploadResult> {
      if (inFlight) return inFlight;
      const current = run(snapshot).finally(() => {
        inFlight = null;
      });
      inFlight = current;
      return current;
    },
    /** Trio `uploadProfiles`: POSTs the profile store (basal, ISF, CR, targets, override presets). Call after settings change. */
    uploadProfile: (input: ProfileUploadInput): Promise<ActionResult> =>
      perform('profile upload', (base) => request(base, PATHS.profile, mapProfileToStore(input))),

    /** Trio `uploadNoteTreatment`: a free-text `Note` treatment at the current time. */
    uploadNote: (note: string): Promise<ActionResult> =>
      perform('note upload', (base) => request(base, PATHS.treatments, [mapNoteToTreatment(note, config.clock.now())])),

    /** Trio `deleteCarbs`/`deleteInsulin`: removes treatments whose `id` equals the Buddy record id. */
    deleteTreatment: (id: string): Promise<ActionResult> =>
      perform('treatment deletion', remove(PATHS.treatments, [['find[id][$eq]', id]])),

    /** Trio `deleteGlucose`: removes the entry with this id or this exact timestamp. */
    deleteGlucose: (id: string, date: Millis): Promise<ActionResult> =>
      perform(
        'glucose deletion',
        remove(PATHS.entries, [
          ['find[$or][0][id][$eq]', id],
          ['find[$or][1][identifier][$eq]', id],
          ['find[$or][2][dateString][$eq]', new Date(date).toISOString()],
        ]),
      ),

    getState: (): UploaderState => state,
    setState(next: Partial<UploaderState>): void {
      state = sanitizeState({ ...state, ...next });
    },
  };
}

export type NightscoutUploader = ReturnType<typeof createNightscoutUploader>;
