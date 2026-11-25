import { newId } from '@buddy/core';
const MIN = 60_000;
/** History kept (and persisted) per pump. */
const HISTORY_RETENTION_MS = 7 * 24 * 60 * MIN;
const HISTORY_MAX_ENTRIES = 2000;
export const emptyLedger = () => ({
    doses: [],
    basal: { kind: 'scheduled', since: 0 },
    pendingBolus: null,
    pendingTempBasal: null,
    uncertainBolus: null,
});
const round3 = (x) => Math.round(x * 1000) / 1000;
export class DoseLedger {
    doses;
    basalSegment;
    pending;
    pendingTemp;
    uncertain;
    constructor(snapshot = emptyLedger()) {
        this.doses = snapshot.doses;
        this.basalSegment = snapshot.basal;
        this.pending = snapshot.pendingBolus;
        this.pendingTemp = snapshot.pendingTempBasal;
        this.uncertain = snapshot.uncertainBolus ?? null;
    }
    snapshot(now) {
        const keepAfter = now - HISTORY_RETENTION_MS;
        const doses = this.doses.filter((d) => d.date >= keepAfter).slice(-HISTORY_MAX_ENTRIES);
        return { doses, basal: this.basalSegment, pendingBolus: this.pending, pendingTempBasal: this.pendingTemp, uncertainBolus: this.uncertain };
    }
    get uncertainBolus() {
        return this.uncertain;
    }
    get basal() {
        return this.basalSegment;
    }
    get pendingBolus() {
        return this.pending;
    }
    get pendingTempBasal() {
        return this.pendingTemp;
    }
    /** Delivered doses with `date >= since`; an open suspend reports its duration so far. */
    history(since, now) {
        const seg = this.basalSegment;
        const out = this.doses
            .map((d) => seg.kind === 'suspended' && d.kind === 'suspend' && d.id === seg.doseId ? { ...d, durationMin: round3(Math.max(0, now - d.date) / MIN) } : d)
            .filter((d) => d.date >= since);
        const p = this.pending;
        if (p && p.delivered > 0 && p.sentAt >= since) {
            out.push({ kind: p.automatic ? 'smb' : 'bolus', date: p.sentAt, units: p.delivered, id: p.id });
        }
        return out.sort((a, b) => a.date - b.date);
    }
    // ── Bolus ──────────────────────────────────────────────────────────────────
    bolusSent(requested, automatic, at) {
        if (this.pending)
            throw new Error('A bolus is already in progress');
        // Reports from now on describe the new bolus, not the uncertain one.
        this.uncertain = null;
        this.pending = { id: newId('medtrum-bolus'), requested, delivered: 0, automatic, sentAt: at, confirmed: false };
        return this.pending;
    }
    bolusConfirmed() {
        if (this.pending)
            this.pending = { ...this.pending, confirmed: true };
    }
    /** The pump definitely refused the bolus: nothing was delivered. */
    bolusRejected() {
        this.pending = null;
    }
    /**
     * Progress from the pump (`updateBolusProgress`). Returns false when the report cannot belong
     * to the pending bolus (more than was requested) and was ignored.
     */
    bolusProgress(delivered, completed) {
        const p = this.pending;
        if (!p)
            return false;
        if (delivered > p.requested + 1e-6)
            return false;
        this.pending = { ...p, delivered, confirmed: true };
        if (completed)
            this.finalizeBolus();
        return true;
    }
    /** Ends the pending bolus with the amount the pump reported delivered when it finished. */
    finalizeBolus() {
        return this.closeBolus(false);
    }
    /**
     * Ends the pending bolus whose outcome is unknown (no status reported it finished): records the
     * requested amount and remembers it, so a later completed report can correct the same dose id.
     */
    finalizeBolusUncertain() {
        return this.closeBolus(true);
    }
    closeBolus(uncertain) {
        const p = this.pending;
        if (!p)
            return null;
        this.pending = null;
        const units = uncertain ? p.requested : p.delivered;
        this.uncertain = uncertain ? { id: p.id, requested: p.requested } : null;
        if (units <= 0)
            return null;
        const dose = { kind: p.automatic ? 'smb' : 'bolus', date: p.sentAt, units, id: p.id };
        this.doses = [...this.doses.filter((d) => d.id !== p.id), dose];
        return dose;
    }
    /**
     * A status reports a completed bolus while none is pending: if a bolus was recorded at its
     * requested amount because its outcome was unknown, correct it to the delivered amount.
     */
    correctUncertainBolus(delivered) {
        const u = this.uncertain;
        if (!u || delivered > u.requested + 1e-6)
            return false;
        this.uncertain = null;
        this.doses = this.doses
            .map((d) => (d.id === u.id && (d.kind === 'bolus' || d.kind === 'smb') ? { ...d, units: delivered } : d))
            .filter((d) => !(d.id === u.id && (d.kind === 'bolus' || d.kind === 'smb') && d.units <= 0));
        return true;
    }
    // ── Basal ──────────────────────────────────────────────────────────────────
    setPendingTempBasal(t) {
        this.pendingTemp = t;
    }
    /** A confirmed temp basal starts (ends any running one at `at`). */
    startTempBasal(rate, durationMin, at) {
        this.endTempBasal(at);
        if (this.basalSegment.kind === 'suspended')
            this.resume(at);
        const doseId = newId('medtrum-temp');
        this.doses = [...this.doses, { kind: 'tempBasal', date: at, rate, durationMin, id: doseId }];
        this.basalSegment = { kind: 'temp', since: at, doseId, rate, durationMin };
        this.pendingTemp = null;
    }
    /** The pump runs a temp basal of unknown duration since `at`: recorded open-ended, 0 min so far. */
    startOpenTempBasal(rate, at, now) {
        this.endTempBasal(at);
        if (this.basalSegment.kind === 'suspended')
            this.resume(at);
        const doseId = newId('medtrum-temp');
        const durationMin = round3(Math.max(0, now - at) / MIN);
        this.doses = [...this.doses, { kind: 'tempBasal', date: at, rate, durationMin, id: doseId }];
        this.basalSegment = { kind: 'temp', since: at, doseId, rate, durationMin, openEnded: true };
        this.pendingTemp = null;
    }
    /** The pump still reports the open-ended temp running at `now`: extend it (same dose id). */
    extendOpenTempBasal(now) {
        const seg = this.basalSegment;
        if (seg.kind !== 'temp' || !seg.openEnded)
            return false;
        const durationMin = round3(Math.max(seg.durationMin, (now - seg.since) / MIN));
        if (durationMin === seg.durationMin)
            return false;
        this.doses = this.doses.map((d) => (d.id === seg.doseId && d.kind === 'tempBasal' ? { ...d, durationMin } : d));
        this.basalSegment = { ...seg, durationMin };
        return true;
    }
    /** The running temp basal (if any) stopped at `at`; it is truncated if that is before its planned end. */
    endTempBasal(at) {
        const seg = this.basalSegment;
        if (seg.kind !== 'temp')
            return false;
        const ranMin = Math.max(0, (at - seg.since) / MIN);
        if (ranMin < seg.durationMin || seg.openEnded) {
            this.doses = this.doses.map((d) => (d.id === seg.doseId && d.kind === 'tempBasal' ? { ...d, durationMin: round3(ranMin) } : d));
        }
        this.basalSegment = { kind: 'scheduled', since: at };
        return true;
    }
    /** The temp basal is over by itself once its duration elapsed. */
    tempBasalActiveAt(now) {
        const seg = this.basalSegment;
        return seg.kind === 'temp' && (seg.openEnded || now < seg.since + seg.durationMin * MIN) ? seg : null;
    }
    /** Delivery stopped at `at` (temp basal ends there). No-op if already suspended. */
    suspend(at) {
        if (this.basalSegment.kind === 'suspended')
            return false;
        this.endTempBasal(at);
        const doseId = newId('medtrum-suspend');
        this.doses = [...this.doses, { kind: 'suspend', date: at, durationMin: 0, id: doseId }];
        this.basalSegment = { kind: 'suspended', since: at, doseId };
        return true;
    }
    /** Delivery resumed on schedule at `at`. No-op if not suspended. */
    resume(at) {
        const seg = this.basalSegment;
        if (seg.kind !== 'suspended')
            return false;
        const durationMin = round3(Math.max(0, at - seg.since) / MIN);
        this.doses = this.doses.map((d) => (d.id === seg.doseId && d.kind === 'suspend' ? { ...d, durationMin } : d));
        this.basalSegment = { kind: 'scheduled', since: at };
        return true;
    }
}
