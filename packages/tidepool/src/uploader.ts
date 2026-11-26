import { systemClock, silentLogger, type Clock, type GlucoseReading, type InsulinDose, type Logger, type Millis } from '@buddy/core';
import { DATA_SET_DEVICE_TAGS, DEDUPLICATOR_DATASET_DELETE_ORIGIN, type TidepoolApi, type TidepoolSelector } from './api';
import type { TidepoolAuth } from './auth';
import { errorText, isTidepoolError, needsReauthentication } from './errors';
import { carbResolvedId, doseSelectors, glucoseSyncId, mapCarbs, mapDeviceEvents, mapDoses, mapGlucoseReadings, mapPumpSettings, mapScheduledBasal, resolvedRecordId } from './mapping';
import type { CarbInput, MappingContext, MappingOptions } from './mapping';
import type { MappedDatum, PumpSettingsSnapshot, ScheduledBasalSegment, TidepoolDatum, TidepoolDeviceEvent } from './types';

/** Collections with their own high-water mark. `settings` has none: it is sent when its content changes. */
export const MARKED_COLLECTIONS = ['glucose', 'doses', 'carbs', 'deviceEvents'] as const;
export const COLLECTIONS = [...MARKED_COLLECTIONS, 'settings'] as const;
export type MarkedCollection = (typeof MARKED_COLLECTIONS)[number];
export type Collection = (typeof COLLECTIONS)[number];

/** Per-request limits TidepoolService declares (`glucoseDataLimit`, `doseDataLimit`, `carbDataLimit`, `settingsDataLimit`). */
export const MAX_BATCH: Readonly<Record<Collection, number>> = { glucose: 1000, doses: 1000, carbs: 1000, deviceEvents: 1000, settings: 400 };

/** Persist this between launches. */
export interface TidepoolUploaderState {
  /** Account the marks belong to; a different account starts from scratch. */
  readonly userId: string | null;
  readonly dataSetId: string | null;
  /** Epoch ms of the newest item uploaded per collection. */
  readonly marks: Readonly<Record<MarkedCollection, Millis>>;
  /** Content key of the last uploaded `pumpSettings`. */
  readonly settingsKey: string | null;
}

export const EMPTY_STATE: TidepoolUploaderState = { userId: null, dataSetId: null, marks: { glucose: 0, doses: 0, carbs: 0, deviceEvents: 0 }, settingsKey: null };

export type CollectionResult =
  | { readonly ok: true; readonly uploaded: number }
  | { readonly ok: false; readonly uploaded: number; readonly error: string };

export interface UploadResult {
  /** True when nothing was attempted. */
  readonly skipped: boolean;
  readonly reason?: 'signed-out';
  /** The user has to sign in again (refresh token refused). */
  readonly reauthRequired: boolean;
  readonly collections: Readonly<Record<Collection, CollectionResult>>;
}

export interface TidepoolUploadSnapshot {
  readonly glucose: readonly GlucoseReading[];
  /** The recent history, not only new doses: see `mapDoses`. */
  readonly doses: readonly InsulinDose[];
  readonly carbs: readonly CarbInput[];
  readonly deviceEvents?: readonly TidepoolDeviceEvent[];
  readonly scheduledBasal?: readonly ScheduledBasalSegment[];
  readonly settings?: PumpSettingsSnapshot | null;
}

export interface TidepoolDeleteRequest {
  readonly doses?: readonly InsulinDose[];
  readonly carbs?: readonly { readonly id: string }[];
  readonly glucose?: readonly GlucoseReading[];
}

export type DeleteResult = { readonly ok: true; readonly deleted: number } | { readonly ok: false; readonly deleted: number; readonly error: string; readonly reauthRequired: boolean };

export interface TidepoolUploaderConfig extends MappingOptions {
  readonly api: TidepoolApi;
  readonly auth: TidepoolAuth;
  readonly clock?: Clock;
  readonly log?: Logger;
  readonly initialState?: Partial<TidepoolUploaderState>;
}

function sanitizeState(s: Partial<TidepoolUploaderState> | undefined): TidepoolUploaderState {
  const marks: Record<MarkedCollection, Millis> = { ...EMPTY_STATE.marks };
  for (const c of MARKED_COLLECTIONS) {
    const v = s?.marks?.[c];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) marks[c] = v;
  }
  return {
    userId: typeof s?.userId === 'string' ? s.userId : null,
    dataSetId: typeof s?.dataSetId === 'string' ? s.dataSetId : null,
    marks,
    settingsKey: typeof s?.settingsKey === 'string' ? s.settingsKey : null,
  };
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Uploads Buddy data to Tidepool the way TidepoolService does: one continuous data set per
 * client, datums with stable ids so a re-sent datum replaces the old one, and per-collection
 * high-water marks so each run only sends what is new. A failure part-way keeps the progress of
 * the batches that succeeded. Never throws: failures are reported in the result.
 */
export function createTidepoolUploader(config: TidepoolUploaderConfig) {
  const clock = config.clock ?? systemClock;
  const log = config.log ?? silentLogger;
  let state = sanitizeState(config.initialState);
  let inFlight: Promise<UploadResult> | null = null;
  let dataSetPromise: Promise<string> | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  async function fetchDataSetId(): Promise<string> {
    const found = await config.api.listDataSets({ clientName: config.clientName, deleted: false });
    if (found.length > 1) log.warn('Tidepool: found several matching data sets, using the first');
    const existing = found[0];
    const existingId = existing?.uploadId ?? existing?.id;
    if (existingId) return existingId;
    const created = await config.api.createDataSet({
      type: 'upload',
      dataSetType: 'continuous',
      client: { name: config.clientName, version: config.clientVersion },
      deduplicator: { name: DEDUPLICATOR_DATASET_DELETE_ORIGIN },
      deviceTags: DATA_SET_DEVICE_TAGS,
    });
    const id = created.id ?? created.uploadId;
    if (!id) throw new Error('Tidepool created a data set without an id');
    log.info('Tidepool: created data set');
    return id;
  }

  /** Cached data set id; concurrent callers share one lookup. */
  function ensureDataSet(): Promise<string> {
    if (state.dataSetId) return Promise.resolve(state.dataSetId);
    dataSetPromise ??= fetchDataSetId()
      .then((id) => {
        state = { ...state, dataSetId: id };
        return id;
      })
      .finally(() => {
        dataSetPromise = null;
      });
    return dataSetPromise;
  }

  /** A different account has none of the old marks or data set. */
  function adoptUser(userId: string): void {
    if (state.userId === userId) return;
    if (state.userId !== null) log.info('Tidepool: account changed, starting a new upload history');
    state = { ...EMPTY_STATE, userId };
    dataSetPromise = null;
  }

  async function sendBatches(collection: Collection, dataSetId: string, items: readonly MappedDatum[], mark: (revisedAt: Millis) => void): Promise<CollectionResult> {
    let uploaded = 0;
    const batches = chunk(items, MAX_BATCH[collection]);
    for (const [i, batch] of batches.entries()) {
      try {
        await config.api.createData(dataSetId, batch.map((m) => m.datum));
      } catch (e) {
        // A data set that has gone away is looked up (or created) again on the next run.
        if (isTidepoolError(e) && e.code === 'not-found') state = { ...state, dataSetId: null };
        const error = `Tidepool ${collection} upload failed: ${errorText(e)}`;
        log.warn(error);
        return { ok: false, uploaded, error: needsReauthentication(e) ? `${error} (sign in again)` : error };
      }
      uploaded += batch.length;
      const last = batch.at(-1)!.revisedAt;
      const next = batches[i + 1]?.[0];
      // If the next batch starts at the same millisecond, stay just below it so a failure there
      // cannot skip it; a re-sent datum only replaces itself, a lost one is gone.
      mark(next && next.revisedAt === last ? last - 1 : last);
    }
    if (uploaded > 0) log.info(`Tidepool: uploaded ${uploaded} ${collection}`);
    return { ok: true, uploaded };
  }

  const pendingAfter = (items: readonly MappedDatum[], mark: Millis, now: Millis): MappedDatum[] =>
    items.filter((m) => m.revisedAt > mark && m.revisedAt <= now).sort((a, b) => a.revisedAt - b.revisedAt);

  async function run(snapshot: TidepoolUploadSnapshot): Promise<UploadResult> {
    const idle: CollectionResult = { ok: true, uploaded: 0 };
    const allIdle = Object.fromEntries(COLLECTIONS.map((c) => [c, idle])) as Record<Collection, CollectionResult>;
    const session = await config.auth.getSession();
    if (!session) return { skipped: true, reason: 'signed-out', reauthRequired: false, collections: allIdle };
    adoptUser(session.userId);

    const ctx: MappingContext = { ...config, userId: session.userId };
    const now = clock.now();
    const mapped: Record<MarkedCollection, MappedDatum[]> = {
      glucose: mapGlucoseReadings(snapshot.glucose, ctx),
      doses: [...mapDoses(snapshot.doses, ctx), ...mapScheduledBasal(snapshot.scheduledBasal ?? [], ctx)],
      carbs: mapCarbs(snapshot.carbs, ctx),
      deviceEvents: mapDeviceEvents(snapshot.deviceEvents ?? [], ctx),
    };
    const pending: Record<MarkedCollection, MappedDatum[]> = {
      glucose: pendingAfter(mapped.glucose, state.marks.glucose, now),
      doses: pendingAfter(mapped.doses, state.marks.doses, now),
      carbs: pendingAfter(mapped.carbs, state.marks.carbs, now),
      deviceEvents: pendingAfter(mapped.deviceEvents, state.marks.deviceEvents, now),
    };
    const settings = snapshot.settings && snapshot.settings.date <= now ? mapPumpSettings(snapshot.settings, ctx) : null;
    const settingsPending = settings !== null && settings.contentKey !== state.settingsKey;

    const results = { ...allIdle };
    if (!settingsPending && MARKED_COLLECTIONS.every((c) => pending[c].length === 0)) return { skipped: false, reauthRequired: false, collections: results };

    let dataSetId: string;
    try {
      dataSetId = await ensureDataSet();
    } catch (e) {
      const error = `Tidepool data set lookup failed: ${errorText(e)}`;
      log.warn(error);
      const failed: CollectionResult = { ok: false, uploaded: 0, error };
      return {
        skipped: false,
        reauthRequired: needsReauthentication(e),
        collections: Object.fromEntries(COLLECTIONS.map((c) => [c, (c === 'settings' ? settingsPending : pending[c].length > 0) ? failed : idle])) as Record<Collection, CollectionResult>,
      };
    }

    // Everything but the dose data (boluses, basals) is independent, but one failing auth should not be hammered four times.
    let reauthRequired = false;
    for (const c of MARKED_COLLECTIONS) {
      if (reauthRequired || pending[c].length === 0) continue;
      const result = await sendBatches(c, dataSetId, pending[c], (revisedAt) => {
        state = { ...state, marks: { ...state.marks, [c]: revisedAt } };
      });
      results[c] = result;
      if (!result.ok && result.error.endsWith('(sign in again)')) reauthRequired = true;
    }
    if (settingsPending && !reauthRequired) {
      const result = await sendBatches('settings', dataSetId, [settings], () => {
        state = { ...state, settingsKey: settings.contentKey };
      });
      results.settings = result;
      if (!result.ok && result.error.endsWith('(sign in again)')) reauthRequired = true;
    }
    return { skipped: false, reauthRequired, collections: results };
  }

  async function removeData(request: TidepoolDeleteRequest): Promise<DeleteResult> {
    const session = await config.auth.getSession();
    if (!session) return { ok: true, deleted: 0 };
    adoptUser(session.userId);
    const ctx: MappingContext = { ...config, userId: session.userId };
    const selectors: TidepoolSelector[] = [
      ...(request.doses ?? []).flatMap((d) => doseSelectors(d, ctx)),
      ...(request.carbs ?? []).map((c): TidepoolSelector => ({ origin: { id: carbResolvedId(ctx, c.id) } })),
      ...(request.glucose ?? []).map((g): TidepoolSelector => ({ origin: { id: resolvedRecordId(ctx, glucoseSyncId(g)) } })),
    ];
    if (selectors.length === 0) return { ok: true, deleted: 0 };
    let deleted = 0;
    try {
      const dataSetId = await ensureDataSet();
      for (const batch of chunk(selectors, MAX_BATCH.doses)) {
        try {
          await config.api.deleteData(dataSetId, batch);
        } catch (e) {
          // Nothing to delete (never uploaded, or already gone) is the state we wanted.
          if (!(isTidepoolError(e) && e.code === 'not-found')) throw e;
        }
        deleted += batch.length;
      }
      log.info(`Tidepool: deleted ${deleted} items`);
      return { ok: true, deleted };
    } catch (e) {
      const error = `Tidepool delete failed: ${errorText(e)}`;
      log.warn(error);
      return { ok: false, deleted, error, reauthRequired: needsReauthentication(e) };
    }
  }

  return {
    /** Concurrent calls share the running upload so nothing is sent twice. */
    upload(snapshot: TidepoolUploadSnapshot): Promise<UploadResult> {
      if (inFlight) return inFlight;
      const current = serialize(() => run(snapshot)).finally(() => {
        inFlight = null;
      });
      inFlight = current;
      return current;
    },
    /** Removes data from Tidepool (a bolus or carb entry the user deleted). Runs after any running upload. */
    delete(request: TidepoolDeleteRequest): Promise<DeleteResult> {
      return serialize(() => removeData(request));
    },
    getState: (): TidepoolUploaderState => state,
    setState(next: Partial<TidepoolUploaderState>): void {
      state = sanitizeState({ ...state, ...next, marks: { ...state.marks, ...next.marks } });
    },
  };
}

export type TidepoolUploader = ReturnType<typeof createTidepoolUploader>;
