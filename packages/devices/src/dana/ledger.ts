/**
 * Dose bookkeeping of the Dana driver: the Buddy counterpart of the `UnfinalizedDose`/
 * `NewPumpEvent` reporting in DanaKit/PumpManager/DanaKitPumpManager.swift (`reportBasal`,
 * suspend/resume events) from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit
 * authors). Only pump-confirmed events are added.
 *
 * Temp basals and suspends are truncated by the next basal event in Buddy's IOB model, so an
 * early end (cancel, resume) is recorded as a zero-length temp basal at the scheduled rate.
 *
 * A percent temp is recorded as consecutive segments (one per profile-hour rate). Ending it early
 * re-reports the segments under the same ids (consumers upsert by id): the running segment gets
 * its real, shorter duration and segments that had not started yet collapse into zero-length
 * entries at the end time, so they can never truncate a later temp.
 */
import type { InsulinDose, Millis, TempBasalState } from '@buddy/core';
import type { TempSegment } from './temp-basal';

/** Suspend has no end on Dana; it is truncated by the next basal event (Buddy's IOB model). */
export const SUSPEND_DURATION_MIN = 24 * 60;
const RETENTION_MS = 7 * 24 * 3_600_000;

export class DoseLedger {
  private doses: InsulinDose[] = [];
  private temp: { readonly startedAt: Millis; readonly durationMin: number; readonly segments: readonly InsulinDose[] } | null = null;
  private suspendedRecorded = false;
  private counter = 0;

  constructor(
    private readonly prefix: string,
    private readonly now: () => Millis,
    /** Scheduled (profile) basal rate at a time, U/h. */
    private readonly scheduledRate: (at: Millis) => number,
  ) {}

  newId(kind: string): string {
    this.counter += 1;
    return `${this.prefix}-${kind}-${this.now()}-${this.counter}`;
  }

  get all(): readonly InsulinDose[] {
    return this.doses;
  }

  get isSuspendedRecorded(): boolean {
    return this.suspendedRecorded;
  }

  since(t: Millis): InsulinDose[] {
    return this.doses.filter((d) => d.date >= t).sort((a, b) => a.date - b.date);
  }

  find(id: string): InsulinDose | undefined {
    return this.doses.find((d) => d.id === id);
  }

  /** Adds a dose, or replaces the dose with the same id (upsert). */
  push(dose: InsulinDose): void {
    const cutoff = this.now() - RETENTION_MS;
    this.doses = [...this.doses.filter((d) => d.date >= cutoff && d.id !== dose.id), dose];
  }

  /** The temp basal this driver set and that has not ended yet (rate of the current segment). */
  activeTemp(at: Millis): TempBasalState | null {
    const t = this.temp;
    if (t && at >= t.startedAt + t.durationMin * 60_000) this.temp = null;
    if (!this.temp) return null;
    const current = [...this.temp.segments].reverse().find((d) => d.date <= at) ?? this.temp.segments[0];
    const rate = current?.kind === 'tempBasal' ? current.rate : 0;
    return { rate, startedAt: this.temp.startedAt, durationMin: this.temp.durationMin };
  }

  /** Records a pump-confirmed temp as its hour segments; returns the first segment. */
  recordTemp(segments: readonly TempSegment[], at: Millis): InsulinDose {
    const base = this.newId('temp');
    const doses: InsulinDose[] = segments.map((s, i) => ({ kind: 'tempBasal', id: segments.length > 1 ? `${base}-s${i}` : base, date: s.date, rate: s.rate, durationMin: s.durationMin }));
    for (const d of doses) this.push(d);
    const durationMin = segments.reduce((sum, s) => sum + s.durationMin, 0);
    this.temp = { startedAt: at, durationMin, segments: doses };
    const first = doses[0];
    if (!first) throw new Error('Temp basal without segments');
    return first;
  }

  /** Ends our temp basal early (cancelled, replaced or stopped on the pump). */
  recordTempEnd(at: Millis): void {
    const t = this.temp;
    if (!this.activeTemp(at) || !t) return;
    for (const d of t.segments) {
      if (d.kind !== 'tempBasal') continue;
      if (d.date >= at) this.push({ ...d, date: at, rate: this.scheduledRate(at), durationMin: 0 });
      else if (d.date + d.durationMin * 60_000 > at) this.push({ ...d, durationMin: (at - d.date) / 60_000 });
    }
    this.push({ kind: 'tempBasal', id: this.newId('temp-end'), date: at, rate: this.scheduledRate(at), durationMin: 0 });
    this.temp = null;
  }

  recordSuspend(at: Millis): InsulinDose {
    const dose: InsulinDose = { kind: 'suspend', id: this.newId('suspend'), date: at, durationMin: SUSPEND_DURATION_MIN };
    this.push(dose);
    this.suspendedRecorded = true;
    this.temp = null;
    return dose;
  }

  recordResume(at: Millis): InsulinDose {
    const dose: InsulinDose = { kind: 'tempBasal', id: this.newId('resume'), date: at, rate: this.scheduledRate(at), durationMin: 0 };
    this.push(dose);
    this.suspendedRecorded = false;
    this.temp = null;
    return dose;
  }
}
