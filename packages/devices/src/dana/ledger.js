/** Suspend has no end on Dana; it is truncated by the next basal event (Buddy's IOB model). */
export const SUSPEND_DURATION_MIN = 24 * 60;
const RETENTION_MS = 7 * 24 * 3_600_000;
export class DoseLedger {
    prefix;
    now;
    scheduledRate;
    doses = [];
    temp = null;
    suspendedRecorded = false;
    counter = 0;
    constructor(prefix, now, 
    /** Scheduled (profile) basal rate at a time, U/h. */
    scheduledRate) {
        this.prefix = prefix;
        this.now = now;
        this.scheduledRate = scheduledRate;
    }
    newId(kind) {
        this.counter += 1;
        return `${this.prefix}-${kind}-${this.now()}-${this.counter}`;
    }
    get all() {
        return this.doses;
    }
    get isSuspendedRecorded() {
        return this.suspendedRecorded;
    }
    since(t) {
        return this.doses.filter((d) => d.date >= t).sort((a, b) => a.date - b.date);
    }
    find(id) {
        return this.doses.find((d) => d.id === id);
    }
    /** Adds a dose, or replaces the dose with the same id (upsert). */
    push(dose) {
        const cutoff = this.now() - RETENTION_MS;
        this.doses = [...this.doses.filter((d) => d.date >= cutoff && d.id !== dose.id), dose];
    }
    /** The temp basal this driver set and that has not ended yet (rate of the current segment). */
    activeTemp(at) {
        const t = this.temp;
        if (t && at >= t.startedAt + t.durationMin * 60_000)
            this.temp = null;
        if (!this.temp)
            return null;
        const current = [...this.temp.segments].reverse().find((d) => d.date <= at) ?? this.temp.segments[0];
        const rate = current?.kind === 'tempBasal' ? current.rate : 0;
        return { rate, startedAt: this.temp.startedAt, durationMin: this.temp.durationMin };
    }
    /** Records a pump-confirmed temp as its hour segments; returns the first segment. */
    recordTemp(segments, at) {
        const base = this.newId('temp');
        const doses = segments.map((s, i) => ({ kind: 'tempBasal', id: segments.length > 1 ? `${base}-s${i}` : base, date: s.date, rate: s.rate, durationMin: s.durationMin }));
        for (const d of doses)
            this.push(d);
        const durationMin = segments.reduce((sum, s) => sum + s.durationMin, 0);
        this.temp = { startedAt: at, durationMin, segments: doses };
        const first = doses[0];
        if (!first)
            throw new Error('Temp basal without segments');
        return first;
    }
    /** Ends our temp basal early (cancelled, replaced or stopped on the pump). */
    recordTempEnd(at) {
        const t = this.temp;
        if (!this.activeTemp(at) || !t)
            return;
        for (const d of t.segments) {
            if (d.kind !== 'tempBasal')
                continue;
            if (d.date >= at)
                this.push({ ...d, date: at, rate: this.scheduledRate(at), durationMin: 0 });
            else if (d.date + d.durationMin * 60_000 > at)
                this.push({ ...d, durationMin: (at - d.date) / 60_000 });
        }
        this.push({ kind: 'tempBasal', id: this.newId('temp-end'), date: at, rate: this.scheduledRate(at), durationMin: 0 });
        this.temp = null;
    }
    recordSuspend(at) {
        const dose = { kind: 'suspend', id: this.newId('suspend'), date: at, durationMin: SUSPEND_DURATION_MIN };
        this.push(dose);
        this.suspendedRecorded = true;
        this.temp = null;
        return dose;
    }
    recordResume(at) {
        const dose = { kind: 'tempBasal', id: this.newId('resume'), date: at, rate: this.scheduledRate(at), durationMin: 0 };
        this.push(dose);
        this.suspendedRecorded = false;
        this.temp = null;
        return dose;
    }
}
