/**
 * Dose bookkeeping for the Medtrum Nano driver. Replaces the LoopKit `UnfinalizedDose` /
 * `NewPumpEvent` plumbing of `MedtrumKit/PumpManager/MedtrumPumpManager.swift` and
 * `Common/UnfinalizedDose.swift` from loopandlearn/MedtrumKit (MIT License, (c) the original
 * MedtrumKit authors) with Buddy's `InsulinDose` history.
 *
 * A bolus appears with the amount the pump reported as delivered (growing while it runs). When
 * its outcome is unknown (link lost, answer lost) and no status reported it finished, the
 * REQUESTED amount is recorded (MedtrumKit's `checkBolusDone` behaviour: over-reporting IOB errs
 * toward less insulin) and corrected under the same dose id if a later status reports the
 * delivered amount. Temp basals appear once the pump confirmed them and are truncated when they
 * end early; a temp of unknown duration is open-ended and extended while the pump reports it.
 * Edited doses keep their id: the core store upserts by id.
 */
import type { InsulinDose, Millis } from '@buddy/core';
import { newId } from '@buddy/core';

const MIN = 60_000;
/** History kept (and persisted) per pump. */
const HISTORY_RETENTION_MS = 7 * 24 * 60 * MIN;
const HISTORY_MAX_ENTRIES = 2000;

export type BasalSegment =
  | { readonly kind: 'scheduled'; readonly since: Millis }
  | {
      readonly kind: 'temp';
      readonly since: Millis;
      readonly doseId: string;
      readonly rate: number;
      readonly durationMin: number;
      /** Duration unknown: recorded up to the last status that showed it running. */
      readonly openEnded?: boolean;
    }
  | { readonly kind: 'suspended'; readonly since: Millis; readonly doseId: string };

export interface PendingBolus {
  readonly id: string;
  readonly requested: number;
  /** Last amount the pump reported as delivered (U). Never more than the pump said. */
  readonly delivered: number;
  readonly automatic: boolean;
  readonly sentAt: Millis;
  /** The pump acknowledged SetBolus (or reported this bolus' progress). */
  readonly confirmed: boolean;
}

/** A SetTempBasal whose answer was lost: adopted if the next status shows it running. */
export interface PendingTempBasal {
  readonly rate: number;
  readonly durationMin: number;
  readonly sentAt: Millis;
}

/** A bolus recorded at its requested amount because its outcome was unknown; correctable by a later status. */
export interface UncertainBolus {
  readonly id: string;
  readonly requested: number;
}

export interface LedgerSnapshot {
  readonly doses: readonly InsulinDose[];
  readonly basal: BasalSegment;
  readonly pendingBolus: PendingBolus | null;
  readonly pendingTempBasal: PendingTempBasal | null;
  readonly uncertainBolus?: UncertainBolus | null;
}

export const emptyLedger = (): LedgerSnapshot => ({
  doses: [],
  basal: { kind: 'scheduled', since: 0 },
  pendingBolus: null,
  pendingTempBasal: null,
  uncertainBolus: null,
});

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export class DoseLedger {
  private doses: readonly InsulinDose[];
  private basalSegment: BasalSegment;
  private pending: PendingBolus | null;
  private pendingTemp: PendingTempBasal | null;
  private uncertain: UncertainBolus | null;

  constructor(snapshot: LedgerSnapshot = emptyLedger()) {
    this.doses = snapshot.doses;
    this.basalSegment = snapshot.basal;
    this.pending = snapshot.pendingBolus;
    this.pendingTemp = snapshot.pendingTempBasal;
    this.uncertain = snapshot.uncertainBolus ?? null;
  }

  snapshot(now: Millis): LedgerSnapshot {
    const keepAfter = now - HISTORY_RETENTION_MS;
    const doses = this.doses.filter((d) => d.date >= keepAfter).slice(-HISTORY_MAX_ENTRIES);
    return { doses, basal: this.basalSegment, pendingBolus: this.pending, pendingTempBasal: this.pendingTemp, uncertainBolus: this.uncertain };
  }

  get uncertainBolus(): UncertainBolus | null {
    return this.uncertain;
  }

  get basal(): BasalSegment {
    return this.basalSegment;
  }
  get pendingBolus(): PendingBolus | null {
    return this.pending;
  }
  get pendingTempBasal(): PendingTempBasal | null {
    return this.pendingTemp;
  }

  /** Delivered doses with `date >= since`; an open suspend reports its duration so far. */
  history(since: Millis, now: Millis): InsulinDose[] {
    const seg = this.basalSegment;
    const out = this.doses
      .map((d): InsulinDose =>
        seg.kind === 'suspended' && d.kind === 'suspend' && d.id === seg.doseId ? { ...d, durationMin: round3(Math.max(0, now - d.date) / MIN) } : d,
      )
      .filter((d) => d.date >= since);
    const p = this.pending;
    if (p && p.delivered > 0 && p.sentAt >= since) {
      out.push({ kind: p.automatic ? 'smb' : 'bolus', date: p.sentAt, units: p.delivered, id: p.id });
    }
    return out.sort((a, b) => a.date - b.date);
  }

  // ── Bolus ──────────────────────────────────────────────────────────────────

  bolusSent(requested: number, automatic: boolean, at: Millis): PendingBolus {
    if (this.pending) throw new Error('A bolus is already in progress');
    // Reports from now on describe the new bolus, not the uncertain one.
    this.uncertain = null;
    this.pending = { id: newId('medtrum-bolus'), requested, delivered: 0, automatic, sentAt: at, confirmed: false };
    return this.pending;
  }

  bolusConfirmed(): void {
    if (this.pending) this.pending = { ...this.pending, confirmed: true };
  }

  /** The pump definitely refused the bolus: nothing was delivered. */
  bolusRejected(): void {
    this.pending = null;
  }

  /**
   * Progress from the pump (`updateBolusProgress`). Returns false when the report cannot belong
   * to the pending bolus (more than was requested) and was ignored.
   */
  bolusProgress(delivered: number, completed: boolean): boolean {
    const p = this.pending;
    if (!p) return false;
    if (delivered > p.requested + 1e-6) return false;
    this.pending = { ...p, delivered, confirmed: true };
    if (completed) this.finalizeBolus();
    return true;
  }

  /** Ends the pending bolus with the amount the pump reported delivered when it finished. */
  finalizeBolus(): InsulinDose | null {
    return this.closeBolus(false);
  }

  /**
   * Ends the pending bolus whose outcome is unknown (no status reported it finished): records the
   * requested amount and remembers it, so a later completed report can correct the same dose id.
   */
  finalizeBolusUncertain(): InsulinDose | null {
    return this.closeBolus(true);
  }

  private closeBolus(uncertain: boolean): InsulinDose | null {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    const units = uncertain ? p.requested : p.delivered;
    this.uncertain = uncertain ? { id: p.id, requested: p.requested } : null;
    if (units <= 0) return null;
    const dose: InsulinDose = { kind: p.automatic ? 'smb' : 'bolus', date: p.sentAt, units, id: p.id };
    this.doses = [...this.doses.filter((d) => d.id !== p.id), dose];
    return dose;
  }

  /**
   * A status reports a completed bolus while none is pending: if a bolus was recorded at its
   * requested amount because its outcome was unknown, correct it to the delivered amount.
   */
  correctUncertainBolus(delivered: number): boolean {
    const u = this.uncertain;
    if (!u || delivered > u.requested + 1e-6) return false;
    this.uncertain = null;
    this.doses = this.doses
      .map((d) => (d.id === u.id && (d.kind === 'bolus' || d.kind === 'smb') ? { ...d, units: delivered } : d))
      .filter((d) => !(d.id === u.id && (d.kind === 'bolus' || d.kind === 'smb') && d.units <= 0));
    return true;
  }

  // ── Basal ──────────────────────────────────────────────────────────────────

  setPendingTempBasal(t: PendingTempBasal | null): void {
    this.pendingTemp = t;
  }

  /** A confirmed temp basal starts (ends any running one at `at`). */
  startTempBasal(rate: number, durationMin: number, at: Millis): void {
    this.endTempBasal(at);
    if (this.basalSegment.kind === 'suspended') this.resume(at);
    const doseId = newId('medtrum-temp');
    this.doses = [...this.doses, { kind: 'tempBasal', date: at, rate, durationMin, id: doseId }];
    this.basalSegment = { kind: 'temp', since: at, doseId, rate, durationMin };
    this.pendingTemp = null;
  }

  /** The pump runs a temp basal of unknown duration since `at`: recorded open-ended, 0 min so far. */
  startOpenTempBasal(rate: number, at: Millis, now: Millis): void {
    this.endTempBasal(at);
    if (this.basalSegment.kind === 'suspended') this.resume(at);
    const doseId = newId('medtrum-temp');
    const durationMin = round3(Math.max(0, now - at) / MIN);
    this.doses = [...this.doses, { kind: 'tempBasal', date: at, rate, durationMin, id: doseId }];
    this.basalSegment = { kind: 'temp', since: at, doseId, rate, durationMin, openEnded: true };
    this.pendingTemp = null;
  }

  /** The pump still reports the open-ended temp running at `now`: extend it (same dose id). */
  extendOpenTempBasal(now: Millis): boolean {
    const seg = this.basalSegment;
    if (seg.kind !== 'temp' || !seg.openEnded) return false;
    const durationMin = round3(Math.max(seg.durationMin, (now - seg.since) / MIN));
    if (durationMin === seg.durationMin) return false;
    this.doses = this.doses.map((d) => (d.id === seg.doseId && d.kind === 'tempBasal' ? { ...d, durationMin } : d));
    this.basalSegment = { ...seg, durationMin };
    return true;
  }

  /** The running temp basal (if any) stopped at `at`; it is truncated if that is before its planned end. */
  endTempBasal(at: Millis): boolean {
    const seg = this.basalSegment;
    if (seg.kind !== 'temp') return false;
    const ranMin = Math.max(0, (at - seg.since) / MIN);
    if (ranMin < seg.durationMin || seg.openEnded) {
      this.doses = this.doses.map((d) => (d.id === seg.doseId && d.kind === 'tempBasal' ? { ...d, durationMin: round3(ranMin) } : d));
    }
    this.basalSegment = { kind: 'scheduled', since: at };
    return true;
  }

  /** The temp basal is over by itself once its duration elapsed. */
  tempBasalActiveAt(now: Millis): Extract<BasalSegment, { kind: 'temp' }> | null {
    const seg = this.basalSegment;
    return seg.kind === 'temp' && (seg.openEnded || now < seg.since + seg.durationMin * MIN) ? seg : null;
  }

  /** Delivery stopped at `at` (temp basal ends there). No-op if already suspended. */
  suspend(at: Millis): boolean {
    if (this.basalSegment.kind === 'suspended') return false;
    this.endTempBasal(at);
    const doseId = newId('medtrum-suspend');
    this.doses = [...this.doses, { kind: 'suspend', date: at, durationMin: 0, id: doseId }];
    this.basalSegment = { kind: 'suspended', since: at, doseId };
    return true;
  }

  /** Delivery resumed on schedule at `at`. No-op if not suspended. */
  resume(at: Millis): boolean {
    const seg = this.basalSegment;
    if (seg.kind !== 'suspended') return false;
    const durationMin = round3(Math.max(0, at - seg.since) / MIN);
    this.doses = this.doses.map((d) => (d.id === seg.doseId && d.kind === 'suspend' ? { ...d, durationMin } : d));
    this.basalSegment = { kind: 'scheduled', since: at };
    return true;
  }
}
