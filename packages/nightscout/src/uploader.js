import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { mapLoopRunToDeviceStatus } from './devicestatus';
import { mapGlucoseToEntries } from './entries';
import { mapCarbsToTreatments, mapDosesToTreatments, mapOverrideToTreatment, mapTempTargetToTreatment } from './treatments';
/** Nightscout and Trio both cap uploads at 100 documents per request. */
export const MAX_BATCH = 100;
const PATHS = {
    entries: '/api/v1/entries.json',
    treatments: '/api/v1/treatments.json',
    devicestatus: '/api/v1/devicestatus.json',
};
export const COLLECTIONS = ['entries', 'doses', 'carbs', 'tempTargets', 'overrides', 'deviceStatus'];
export const EMPTY_STATE = { entries: 0, doses: 0, carbs: 0, tempTargets: 0, overrides: 0, deviceStatus: 0 };
/** Lowercase hex SHA-1, the form Nightscout expects in the `api-secret` header. */
export const hashApiSecret = (secret) => bytesToHex(sha1(utf8ToBytes(secret)));
function normalizeBaseUrl(raw) {
    const url = raw.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^\s/]+/i.test(url))
        throw new Error('Nightscout URL must start with https://');
    return url;
}
const errorText = (e) => (e instanceof Error ? e.message : String(e));
function sanitizeState(s) {
    const out = { ...EMPTY_STATE };
    for (const c of COLLECTIONS) {
        const v = s?.[c];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
            out[c] = v;
    }
    return out;
}
/**
 * Uploads Buddy data to Nightscout the way Trio does. Each collection only sends items newer
 * than its high-water mark; the mark advances per successful batch, so a failure part-way
 * resumes where it stopped. Never throws: every failure is reported in the result.
 */
export function createNightscoutUploader(config) {
    let state = sanitizeState(config.initialState);
    let inFlight = null;
    function request(base, path, body) {
        const query = config.token ? `?${new URLSearchParams({ token: config.token }).toString()}` : '';
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (config.apiSecret)
            headers['api-secret'] = hashApiSecret(config.apiSecret);
        return config.fetch(`${base}${path}${query}`, { method: 'POST', headers, body: JSON.stringify(body) });
    }
    async function send(base, collection, path, items) {
        const now = config.clock.now();
        const pending = items.filter((p) => p.date > state[collection] && p.date <= now).sort((a, b) => a.date - b.date);
        let uploaded = 0;
        for (let i = 0; i < pending.length; i += MAX_BATCH) {
            const batch = pending.slice(i, i + MAX_BATCH);
            try {
                const res = await request(base, path, batch.map((p) => p.doc));
                if (!res.ok)
                    throw new Error(`HTTP ${res.status}`);
            }
            catch (e) {
                const error = `Nightscout ${collection} upload failed: ${errorText(e)}`;
                config.log.warn(error);
                return { ok: false, uploaded, error };
            }
            uploaded += batch.length;
            // If the next batch starts at the same millisecond, stay just below it so a failure there
            // cannot skip it; a re-sent duplicate is harmless, a lost treatment is not.
            const last = batch.at(-1).date;
            const next = pending[i + MAX_BATCH];
            state = { ...state, [collection]: next && next.date === last ? last - 1 : last };
        }
        if (uploaded > 0)
            config.log.info(`Nightscout: uploaded ${uploaded} ${collection}`);
        return { ok: true, uploaded };
    }
    const treatmentsOf = (docs) => docs.map((doc) => ({ date: Date.parse(doc.created_at), doc }));
    async function run(snapshot) {
        const idle = { ok: true, uploaded: 0 };
        if (!config.url.trim()) {
            return { skipped: true, collections: Object.fromEntries(COLLECTIONS.map((c) => [c, idle])) };
        }
        let base;
        try {
            base = normalizeBaseUrl(config.url);
        }
        catch (e) {
            const failed = { ok: false, uploaded: 0, error: errorText(e) };
            return { skipped: false, collections: Object.fromEntries(COLLECTIONS.map((c) => [c, failed])) };
        }
        const latestRun = snapshot.loopRuns.reduce((best, r) => (!best || r.date > best.date ? r : best), null);
        // Only the newest loop run is uploaded (like Trio): devicestatus carries the *current* pump state.
        const statuses = latestRun ? [{ date: latestRun.date, doc: mapLoopRunToDeviceStatus(latestRun, snapshot.pump, snapshot.uploader) }] : [];
        return {
            skipped: false,
            collections: {
                entries: await send(base, 'entries', PATHS.entries, mapGlucoseToEntries(snapshot.glucose).map((doc) => ({ date: doc.date, doc }))),
                doses: await send(base, 'doses', PATHS.treatments, treatmentsOf(mapDosesToTreatments(snapshot.doses))),
                carbs: await send(base, 'carbs', PATHS.treatments, treatmentsOf(mapCarbsToTreatments(snapshot.carbs))),
                tempTargets: await send(base, 'tempTargets', PATHS.treatments, treatmentsOf((snapshot.tempTargets ?? []).map(mapTempTargetToTreatment))),
                overrides: await send(base, 'overrides', PATHS.treatments, treatmentsOf((snapshot.overrides ?? []).map(mapOverrideToTreatment))),
                deviceStatus: await send(base, 'deviceStatus', PATHS.devicestatus, statuses),
            },
        };
    }
    return {
        /** Concurrent calls share the running upload so nothing is sent twice. */
        upload(snapshot) {
            if (inFlight)
                return inFlight;
            const current = run(snapshot).finally(() => {
                inFlight = null;
            });
            inFlight = current;
            return current;
        },
        getState: () => state,
        setState(next) {
            state = sanitizeState({ ...state, ...next });
        },
    };
}
