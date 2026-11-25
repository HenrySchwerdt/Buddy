import { HistoryCode } from './packets/history';
/** Allowed difference between the bolus run time and the pump's record timestamp (after clock-offset correction). */
export const MATCH_SKEW_MS = 2 * 60_000;
/** After the expected end, how long a missing history record is still put down to a slow pump. */
export const UNCERTAIN_GRACE_MS = 2 * 60_000;
/** Without a DELIVERY_COMPLETE notification this long after the expected end, the bolus is uncertain. */
export const COMPLETION_OVERDUE_MS = 60_000;
/** Own-bolus fingerprints are kept this long (history uploads never reach further back in practice). */
export const FINGERPRINT_RETENTION_MS = 48 * 3_600_000;
/** Slack when comparing a history value against the requested amount (pump rounding). */
const VALUE_SLACK = 0.05;
export const historyRecordId = (deviceName, item) => `dana-${deviceName}-hist-${Array.from(item.raw, (b) => b.toString(16).padStart(2, '0')).join('')}`;
export const bolusDose = (b, units) => ({
    kind: b.automatic ? 'smb' : 'bolus',
    id: b.id,
    date: b.startedAt,
    units: Math.round(units * 100) / 100,
});
export const fingerprintOf = (b) => ({ id: b.id, start: b.startedAt, end: b.expectedEnd, requested: b.requested });
/** Distance of a record (pump clock) from a bolus run time (phone clock + offset); null when outside the window. */
function distance(r, f, pumpClockOffset) {
    if (r.code !== HistoryCode.RECORD_TYPE_BOLUS || r.value === undefined || r.value > f.requested + VALUE_SLACK)
        return null;
    const start = f.start + pumpClockOffset;
    const end = f.end + pumpClockOffset;
    if (r.timestamp < start - MATCH_SKEW_MS || r.timestamp > end + MATCH_SKEW_MS)
        return null;
    return Math.abs(r.timestamp - start);
}
/**
 * Attributes bolus records to our boluses, nearest first, one record per bolus. Returns the new
 * attributions (fingerprint id → record) for fingerprints that had none yet.
 */
export function attributeRecords(records, fingerprints, pumpClockOffset, idOf) {
    const takenRecords = new Set(fingerprints.flatMap((f) => (f.recordId ? [f.recordId] : [])));
    const pairs = [];
    for (const f of fingerprints) {
        if (f.recordId)
            continue;
        for (const r of records) {
            if (takenRecords.has(idOf(r)))
                continue;
            const d = distance(r, f, pumpClockOffset);
            if (d !== null)
                pairs.push({ f, r, d });
        }
    }
    pairs.sort((a, b) => a.d - b.d);
    const result = new Map();
    for (const { f, r } of pairs) {
        if (result.has(f.id) || takenRecords.has(idOf(r)))
            continue;
        result.set(f.id, r);
        takenRecords.add(idOf(r));
    }
    return result;
}
