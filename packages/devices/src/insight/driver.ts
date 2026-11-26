/**
 * Accu-Chek Insight pump driver: a TypeScript port of the dosing side of InsightKit
 * (InsightPumpManager+PumpManager.swift) behind Buddy's `PumpDriver` contract. The pump is
 * controlled through an InsightBridge Android app over BLE (see PROTOCOL.md in InsightKit).
 *
 * Contract guarantees (see also driver-core.ts):
 * - `ok: true` only after the bridge confirmed that the pump accepted the command;
 * - `history()` lists only insulin the pump confirmed (a running bolus counts with the amount
 *   delivered so far, never with the programmed amount);
 * - a command whose outcome is unknown (link lost, timeout, unreadable answer, app restart) is
 *   recorded and blocks everything that adds insulin until it is resolved. Resolving only reads;
 *   a dosing command is never retried automatically;
 * - the record of a command is persisted before the command is sent; if it cannot be persisted
 *   the command is not sent;
 * - commands that only reduce insulin (cancel bolus, cancel temp basal, suspend, temp basal at or
 *   below 100 %) are never blocked by an unresolved command and go first in the queue.
 *
 * Every public method resolves except `connect()` (the only way to report a failed connection).
 */
import type { CommandResult, DeviceContext, DeviceMeta, InsulinDose, Millis, PumpDriver, PumpState } from '@buddy/core';
import { deleteCredentials } from './credentials';
import {
  bolusStepFor,
  DosingMathError,
  normalizedBolus,
  planTempBasal,
  profileKey as profileKeyOf,
  profileSegments,
  scheduledRateAt,
  validateBolus,
  INSIGHT_SPEC,
} from './dosing-math';
import { errorText, fail, InsightCore, UNCERTAIN_TEXT, type InsightDriverOptions, type InsightSettings, type ResolveOutcome } from './driver-core';
import * as L from './ledger';
import { BridgeError, isDelivering, type BridgeAlert, type BridgeStatus } from './models';
import { stateKey, type PendingCommand } from './state';

export const INSIGHT_META: DeviceMeta = {
  id: 'accu-chek-insight',
  name: 'Accu-Chek Insight',
  manufacturer: 'Roche',
  description:
    'Experimental driver for the Accu-Chek Insight pump through an InsightBridge Android app (port of InsightKit). Never verified on hardware by Buddy: test with a pump that is not worn before any use.',
  transport: 'ble',
  maturity: 'experimental',
};

const MIN = 60_000;
/** History is re-read when older than this (the loop runs every 5 minutes). */
const HISTORY_STALE_MS = 4 * MIN;
const STATUS_STALE_FOR_CANCEL_MS = 60_000;
const MAX_PROFILE_AUTO_ATTEMPTS = 3;

export interface InsightPumpInfo {
  readonly bridgeId: string;
  readonly connected: boolean;
  readonly needsRepair: boolean;
  readonly serial: string | null;
  readonly firmware: string | null;
  readonly pumpLink: BridgeStatus['pumpLink'] | null;
  readonly operatingMode: BridgeStatus['operatingMode'] | null;
  readonly activeAlert: BridgeAlert | null;
  readonly profileConfirmed: boolean;
  readonly profileError: string | null;
  readonly pending: PendingCommandInfo | null;
}

export interface PendingCommandInfo {
  readonly kind: PendingCommand['kind'];
  readonly sentAt: Millis;
  readonly units?: number;
  readonly percent?: number;
  readonly durationMin?: number;
}

type Failure = { readonly ok: false; readonly error: string };

const certainFailure = (e: unknown): BridgeError => (e instanceof BridgeError ? e : new BridgeError('linkLost'));

export class InsightPumpDriver extends InsightCore implements PumpDriver {
  constructor(settings: InsightSettings, ctx: DeviceContext, options: InsightDriverOptions = {}) {
    super(INSIGHT_META, settings, ctx, options);
  }

  // ── PumpDriver: connection and reading ─────────────────────────────────────

  connect(): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.load();
      try {
        await this.ensureConnected();
      } catch (e) {
        throw new Error(errorText(e));
      }
      await this.refreshAll('connect');
      await this.resolvePendingNow('connect');
      await this.autoSyncProfile();
    });
  }

  async disconnect(): Promise<void> {
    this.clearResolveTimer();
    await this.queue.enqueue(() => this.client.disconnect());
  }

  async status(): Promise<PumpState> {
    try {
      await this.queue.enqueue(async () => {
        await this.load();
        const stale = this.lastStatusReceived === null || this.now() - this.lastStatusReceived >= 60_000;
        const owed = this.statusDirty || stale || this.state.bolus !== null || this.state.pending !== null;
        if (!owed || !this.canTryReconnect()) return;
        try {
          await this.ensureConnected();
          await this.refreshAll('status');
          if (this.state.pending?.isUncertain) await this.resolvePendingNow('status');
        } catch (e) {
          this.log.warn(`Insight status: using the last known state (${errorText(e)})`);
        }
      });
    } catch (e) {
      this.log.warn(`Insight status: ${errorText(e)}`);
    }
    return this.snapshotState();
  }

  async history(since: Millis): Promise<InsulinDose[]> {
    try {
      await this.queue.enqueue(async () => {
        await this.load();
        const s = this.state;
        const owed = this.statusDirty || s.bolus !== null || s.pending !== null || s.lastHistoryRead === null || this.now() - s.lastHistoryRead >= HISTORY_STALE_MS;
        if (!owed || !this.canTryReconnect()) return;
        try {
          await this.ensureConnected();
          await this.refreshAll('history');
        } catch (e) {
          this.log.warn(`Insight history: using the ledger (${errorText(e)})`);
        }
      });
      return L.historyOf(this.state, since, this.now());
    } catch (e) {
      this.log.error(`Insight history: ${errorText(e)}`);
      return [];
    }
  }

  // ── PumpDriver: dosing ─────────────────────────────────────────────────────

  bolus(units: number, options: { readonly automatic: boolean }): Promise<CommandResult> {
    return this.queue.enqueue(() => this.guarded('bolus', () => this.enactBolus(units, options.automatic)));
  }

  cancelBolus(): Promise<CommandResult> {
    return this.queue.enqueue(() => this.guarded('cancelBolus', () => this.enactCancelBolus()), true);
  }

  setTempBasal(rate: number, durationMin: number): Promise<CommandResult> {
    return this.queue.enqueue(() => this.guarded('setTempBasal', () => this.enactTempBasal(rate, durationMin)));
  }

  cancelTempBasal(): Promise<CommandResult> {
    return this.queue.enqueue(() => this.guarded('cancelTempBasal', () => this.enactCancelTemp()), true);
  }

  suspend(): Promise<CommandResult> {
    return this.queue.enqueue(() => this.guarded('suspend', () => this.enactMode('stopped')), true);
  }

  resume(): Promise<CommandResult> {
    return this.queue.enqueue(() => this.guarded('resume', () => this.enactMode('started')));
  }

  /** Anything unexpected that escapes before a command was sent is a plain failure, never an exception. */
  private async guarded(name: string, fn: () => Promise<CommandResult>): Promise<CommandResult> {
    try {
      await this.load();
      return await fn();
    } catch (e) {
      this.log.error(`Insight ${name}: ${errorText(e)}`);
      return fail(`${name}: ${errorText(e)}`);
    }
  }

  // ── gates ──────────────────────────────────────────────────────────────────

  /** `null` when no unresolved command exists (after trying to resolve one); otherwise the refusal text. */
  private async insulinGate(): Promise<string | null> {
    const p = this.state.pending;
    if (!p) return null;
    // A record that was never marked uncertain but is still here (a command that died halfway) is just as unknown.
    if (!p.isUncertain) await this.markUncertain(p.requestId);
    await this.resolvePendingNow('before dosing');
    return this.state.pending ? UNCERTAIN_TEXT : null;
  }

  private suspendedNow(): boolean {
    const st = this.lastStatus;
    if (st && st.operatingMode !== 'unknown' && !this.statusDirty) return !isDelivering(st.operatingMode);
    return this.state.suspended !== null;
  }

  private bolusRunning(): boolean {
    // An unreadable list is unknown, not "none": a bolus may be running, so nothing is added on top of it.
    return this.state.bolus !== null || (this.lastStatus !== null && !this.statusDirty && (this.lastStatus.boluses.length > 0 || this.lastStatus.bolusesAreUnreadable));
  }

  /** Records `command` as the unresolved one. Refuses (false) if *any* command is still recorded. */
  private async beginPending(command: PendingCommand): Promise<boolean> {
    if (this.pendingId() !== null) return false;
    try {
      await this.mutate((s) => (s.pending ? s : { ...s, pending: command }));
    } catch (e) {
      // Not stored, so not sent: the record must not linger in memory and block dosing for no reason.
      await this.clearPending(command.requestId);
      throw e;
    }
    return this.pendingId() === command.requestId;
  }

  private pendingId(): string | null {
    return this.state.pending?.requestId ?? null;
  }

  private async clearPending(requestId: string): Promise<void> {
    await this.mutateQuiet((s) => (s.pending?.requestId === requestId ? { ...s, pending: null } : s));
  }

  private uncertainFailure(what: string, e: BridgeError): Failure {
    return fail(`${what}: the outcome is unknown (${e.message}) It is checked automatically; no further insulin is added until it is resolved.`);
  }

  // ── bolus ──────────────────────────────────────────────────────────────────

  private async enactBolus(units: number, automatic: boolean): Promise<CommandResult> {
    if (!Number.isFinite(units) || units <= 0) return fail('The bolus amount must be greater than 0.');
    const refusal = await this.bolusRefusal();
    if (refusal) return fail(refusal);
    const pre = await this.preflight();
    if (pre) return fail(pre);
    // Everything may have changed while connecting: check again with the fresh status.
    const again = await this.bolusRefusal();
    if (again) return fail(again);

    const step = this.bolusStep(units);
    const rounded = normalizedBolus(units, step); // never more than asked
    try {
      validateBolus(rounded, this.maxBolus(), bolusStepFor(rounded, step), this.lastStatus?.reservoirUnits ?? null);
    } catch (e) {
      return fail(e instanceof DosingMathError ? e.message : errorText(e));
    }

    const requestId = this.newRequestId('bolus');
    const sentAt = this.now();
    // Record the intent *before* anything is sent. If the app dies now, the next launch knows.
    let recorded: boolean;
    try {
      recorded = await this.beginPending({ kind: 'bolus', requestId, sentAt, baselineSequence: this.state.lastHistorySequence, units: rounded, automatic, isUncertain: false });
    } catch {
      return fail('The pump state could not be stored, so no insulin was sent.');
    }
    if (!recorded) return fail(UNCERTAIN_TEXT);
    this.log.info(`Insight: enact bolus ${rounded} U`);

    try {
      const started = await this.client.deliverBolus(rounded, requestId);
      const reported = Number.isFinite(started.amount) && started.amount > 0 ? started.amount : rounded;
      if (Math.abs(reported - rounded) > 0.005) this.log.error(`Insight: the bridge programmed ${reported} U instead of ${rounded} U`);
      const acceptedAt = this.now();
      await this.mutateQuiet((s) => {
        const next = s.pending?.requestId === requestId ? { ...s, pending: null } : s;
        return L.trackBolus(next, { requestId, units: reported, bolusId: started.bolusId, sentAt, acceptedAt, automatic, delivered: 0, missCount: 0, stopped: false });
      });
      this.statusDirty = true;
      return { ok: true };
    } catch (e) {
      const err = certainFailure(e);
      if (err.isUncertainOutcome || !(e instanceof BridgeError)) {
        await this.markUncertain(requestId);
        return this.uncertainFailure('Bolus', err);
      }
      await this.clearPending(requestId);
      return fail(err.message);
    }
  }

  private async bolusRefusal(): Promise<string | null> {
    const gate = await this.insulinGate();
    if (gate) return gate;
    if (this.bolusRunning()) return 'A bolus is already in progress.';
    if (this.suspendedNow()) return 'The pump is suspended.';
    return null;
  }

  /** Risk reducing: never blocked by an unresolved command. */
  private async enactCancelBolus(): Promise<CommandResult> {
    const tracked = this.state.bolus;
    const pending = this.state.pending?.kind === 'bolus' ? this.state.pending : null;
    if (!tracked && !pending) {
      // An externally programmed bolus may be running: look at the last status.
      if (this.lastStatus && !this.statusDirty && this.lastStatus.boluses.length === 0) return { ok: true };
      try {
        await this.ensureConnected();
        await this.refreshAll('cancelBolus');
      } catch (e) {
        return fail(`cancelBolus: ${errorText(e)}`);
      }
      if (!this.bolusRunning()) return { ok: true };
      const running = this.lastStatus?.boluses[0];
      return running ? this.cancelById(running.bolusId, null) : fail('The bolus cannot be cancelled yet.');
    }
    if (tracked?.bolusId != null) return this.cancelById(tracked.bolusId, tracked.requestId);
    // A bolus whose start is unresolved: its id is unknown here, ask the bridge. Never reports success while one might run.
    try {
      await this.ensureConnected();
      const status = await this.client.getStatus();
      await this.applyStatus(status);
    } catch (e) {
      return fail(`The bolus is still being started and cannot be cancelled yet (${errorText(e)}).`);
    }
    const st = this.lastStatus;
    if (!st || st.bolusesAreUnreadable) return fail('The bolus is still being started and cannot be cancelled yet.');
    const units = pending?.units ?? tracked?.units ?? -1;
    const running = st.boluses.find((b) => Math.abs(b.amount - units) < 0.005) ?? (st.boluses.length === 1 ? st.boluses[0] : undefined);
    if (running) return this.cancelById(running.bolusId, tracked?.requestId ?? null);
    if (pending && st.timestamp !== null && st.timestamp > pending.sentAt) return { ok: true }; // read after the start: no bolus is running
    return fail('The bolus is still being started and cannot be cancelled yet. Try again in a few seconds or suspend the pump.');
  }

  private async cancelById(bolusId: number, requestId: string | null): Promise<CommandResult> {
    try {
      await this.ensureConnected();
      const r = await this.client.cancelBolus(bolusId);
      let dose: InsulinDose | undefined;
      await this.mutateQuiet((s) => {
        const b = s.bolus;
        if (!b || (requestId !== null && b.requestId !== requestId)) return s;
        // The pump says how much it delivered; if it does not, the last evidence stands (the history event corrects it later).
        const delivered = r.delivered !== null ? Math.min(Math.max(r.delivered, 0), b.units) : b.delivered;
        const next = L.finishBolus(L.patchBolus(s, { stopped: true }), delivered, r.delivered !== null);
        dose = next.doses.find((d) => d.id === L.bolusDoseId(b.requestId));
        return next;
      });
      this.statusDirty = true;
      void this.refreshAll('bolus cancelled');
      return dose ? { ok: true, dose } : { ok: true };
    } catch (e) {
      this.statusDirty = true;
      return fail(`Failed to cancel the bolus: ${errorText(e)}`);
    }
  }

  // ── temp basal ─────────────────────────────────────────────────────────────

  private async enactTempBasal(rate: number, durationMin: number): Promise<CommandResult> {
    if (!Number.isFinite(rate) || rate < 0) return fail(`Temp basal rate ${rate} U/h is invalid.`);
    if (!this.profile) return fail(this.profileError ?? 'No basal profile is set.');
    if (rate > this.maxBasal() + 1e-9) return fail(`Temp basal rate ${rate} U/h exceeds the maximum of ${this.maxBasal()} U/h.`);

    const pre = await this.preflight();
    if (pre) return fail(pre);
    if (this.suspendedNow()) return fail('The pump is suspended.');

    const now = this.now();
    const offset = this.utcOffsetSeconds();
    let plan;
    try {
      plan = planTempBasal(rate, this.profile, now, offset, durationMin);
    } catch (e) {
      return fail(e instanceof DosingMathError ? e.message : errorText(e));
    }
    if (plan.kind === 'cancel') return this.enactCancelTemp();

    const reduceOnly = plan.percent <= 100;
    if (!reduceOnly) {
      // Adding insulin: no unresolved command, and the pump must hold the profile the percentage refers to.
      const gate = await this.insulinGate();
      if (gate) return fail(gate);
      if (!this.profileConfirmed()) return fail('The basal profile on the pump is not confirmed. Sync the basal profile in the pump settings.');
    }
    // A zero temp is always safe; anything else is a percentage of what the pump schedules, so the pump must agree with the profile.
    if (plan.percent > 0) {
      const mismatch = await this.checkBasalRate();
      if (mismatch) return fail(mismatch);
    }

    const scheduled = scheduledRateAt(this.profile, now, offset);
    const requestId = this.newRequestId('tbr');
    const sentAt = this.now();
    let recorded = false;
    try {
      recorded = await this.beginPending({
        kind: 'setTBR',
        requestId,
        sentAt,
        baselineSequence: this.state.lastHistorySequence,
        percent: plan.percent,
        durationMin: plan.durationMinutes,
        scheduledRate: scheduled,
        automatic: true,
        isUncertain: false,
      });
    } catch {
      if (!reduceOnly) return fail('The pump state could not be stored, so no insulin was sent.');
    }
    // A reduce-only temp basal may run next to an unresolved command; anything that adds insulin may not.
    if (!recorded && !reduceOnly) return fail(UNCERTAIN_TEXT);
    this.log.info(`Insight: set TBR ${plan.percent}% for ${plan.durationMinutes} min`);

    try {
      const set = await this.client.setTBR(plan.percent, plan.durationMinutes, requestId);
      // Record what the pump reports, whatever it is; a difference is surfaced.
      const percent = set.percent >= 0 && set.percent <= INSIGHT_SPEC.tbrMaxPercent ? set.percent : plan.percent;
      const minutes = set.duration >= 1 && set.duration <= INSIGHT_SPEC.tbrMaxMinutes ? set.duration : plan.durationMinutes;
      if (set.percent !== plan.percent || set.duration !== plan.durationMinutes) this.log.warn(`Insight: the bridge set ${set.percent}% / ${set.duration} min instead of ${plan.percent}% / ${plan.durationMinutes} min`);
      await this.mutateQuiet((s) => this.recordTemp(s.pending?.requestId === requestId ? { ...s, pending: null } : s, requestId, percent, minutes, sentAt, scheduled));
      this.statusDirty = true;
      return { ok: true };
    } catch (e) {
      const err = certainFailure(e);
      if (err.isUncertainOutcome || !(e instanceof BridgeError)) {
        if (recorded) await this.markUncertain(requestId);
        else this.statusDirty = true; // the status is authoritative for a reduce-only temp basal
        return this.uncertainFailure('Temp basal', err);
      }
      if (recorded) await this.clearPending(requestId);
      return fail(err.message);
    }
  }

  /** Stops a running temp basal. A reduce-only command: sent even while another command is unresolved. */
  private async enactCancelTemp(): Promise<CommandResult> {
    const now = this.now();
    const st = this.lastStatus;
    const statusAge = this.lastStatusReceived === null ? Infinity : now - this.lastStatusReceived;
    const mayBeRunning = L.activeTemp(this.state, now) !== null || st?.tbr != null || st?.tbrIsUnreadable === true || statusAge > STATUS_STALE_FOR_CANCEL_MS || this.statusDirty;
    if (!mayBeRunning) return { ok: true };
    // If the status is old we cannot know that nothing runs: cancelling is harmless, so just do it.
    try {
      await this.ensureConnected();
    } catch (e) {
      return fail(`cancelTempBasal: ${errorText(e)}`);
    }
    const requestId = this.newRequestId('tbrcancel');
    const sentAt = this.now();
    let recorded = false;
    try {
      recorded = await this.beginPending({ kind: 'cancelTBR', requestId, sentAt, baselineSequence: this.state.lastHistorySequence, automatic: true, isUncertain: false });
    } catch {
      // A cancel only reduces insulin: it is sent even though it could not be recorded.
    }
    try {
      await this.client.cancelTBR(requestId);
      await this.mutateQuiet((s) => L.endTemp(s.pending?.requestId === requestId ? { ...s, pending: null } : s, sentAt));
      this.statusDirty = true;
      return { ok: true };
    } catch (e) {
      const err = certainFailure(e);
      if (err.isUncertainOutcome || !(e instanceof BridgeError)) {
        if (recorded) await this.markUncertain(requestId);
        else this.statusDirty = true;
        return this.uncertainFailure('Cancel temp basal', err);
      }
      if (recorded) await this.clearPending(requestId);
      return fail(err.message);
    }
  }

  // ── suspend / resume ───────────────────────────────────────────────────────

  /** Suspending only reduces delivery: never blocked by an unresolved command. Resuming keeps every gate. */
  private async enactMode(mode: 'started' | 'stopped'): Promise<CommandResult> {
    const safety = mode === 'stopped';
    if (!safety) {
      const gate = await this.insulinGate();
      if (gate) return fail(gate);
    }
    try {
      await this.ensureConnected();
    } catch (e) {
      return fail(`${safety ? 'suspend' : 'resume'}: ${errorText(e)}`);
    }
    if (this.statusDirty) await this.refreshAll('mode');
    if (safety && this.suspendedNow()) return { ok: true };
    if (!safety && !this.suspendedNow() && this.lastStatus?.operatingMode === 'started') return { ok: true };

    const requestId = this.newRequestId(safety ? 'suspend' : 'resume');
    const sentAt = this.now();
    let recorded = false;
    try {
      recorded = await this.beginPending({ kind: safety ? 'suspend' : 'resume', requestId, sentAt, baselineSequence: this.state.lastHistorySequence, automatic: false, isUncertain: false });
    } catch {
      if (!safety) return fail('The pump state could not be stored, so nothing was sent.');
    }
    if (!recorded && !safety) return fail(UNCERTAIN_TEXT);

    try {
      await this.client.setOperatingMode(mode, requestId);
      this.lastModeCommandAt = sentAt;
      await this.mutateQuiet((s) => {
        const next = s.pending?.requestId === requestId ? { ...s, pending: null } : s;
        return safety ? L.suspend(next, sentAt, `insight-suspend-${requestId}`) : L.resume(next, sentAt);
      });
      this.statusDirty = true;
      return { ok: true };
    } catch (e) {
      const err = certainFailure(e);
      if (err.isUncertainOutcome || !(e instanceof BridgeError)) {
        if (recorded) await this.markUncertain(requestId);
        else this.statusDirty = true;
        return this.uncertainFailure(safety ? 'Suspend' : 'Resume', err);
      }
      if (recorded) await this.clearPending(requestId);
      return fail(err.message);
    }
  }

  // ── profile and time ───────────────────────────────────────────────────────

  /**
   * Writes the `basalProfile` setting to the pump (profile 1) and records it as confirmed only after
   * the bridge's read-back matched. Never while a temp basal runs (the pump keeps its percentage),
   * a bolus runs or a command is unresolved.
   */
  syncBasalProfile(): Promise<CommandResult> {
    return this.queue.enqueue(() => this.guarded('syncBasalProfile', () => this.writeProfile()));
  }

  private async writeProfile(): Promise<CommandResult> {
    if (!this.profile) return fail(this.profileError ?? 'No basal profile is set.');
    if (this.state.pending) return fail(UNCERTAIN_TEXT);
    const pre = await this.preflight();
    if (pre) return fail(pre);
    if (this.state.bolus || this.bolusRunning()) return fail('A bolus is running.');
    if (L.activeTemp(this.state, this.now()) || this.lastStatus?.tbr || this.lastStatus?.tbrIsUnreadable) return fail('A temp basal is running. Cancel it before writing the basal profile.');
    const key = profileKeyOf(this.profile);
    // From the moment the write is sent the pump's profile is unknown until it is read back.
    try {
      await this.mutate((s) => ({ ...s, profileKey: null }));
    } catch {
      return fail('The pump state could not be stored, so the profile was not written.');
    }
    try {
      await this.client.setBasalProfile(profileSegments(this.profile), this.newRequestId('profile'));
      await this.mutateQuiet((s) => ({ ...s, profileKey: key }));
      this.basalMismatchCount = 0;
      this.statusDirty = true;
      return { ok: true };
    } catch (e) {
      this.statusDirty = true;
      return fail(`The basal profile could not be confirmed on the pump: ${errorText(e)}`);
    }
  }

  /** On connect: when the pump does not hold the configured profile, write it (at most a few times per run). */
  protected async autoSyncProfile(): Promise<void> {
    if (!this.profile || this.profileConfirmed() || this.profileAutoAttempts >= MAX_PROFILE_AUTO_ATTEMPTS) return;
    if (this.state.pending || this.state.bolus || L.activeTemp(this.state, this.now()) || this.lastStatus?.tbr || this.suspendedNow()) return;
    this.profileAutoAttempts += 1;
    const r = await this.writeProfile().catch((e: unknown) => fail(errorText(e)));
    if (!r.ok) this.log.warn(`Insight: automatic profile write did not complete (${r.error})`);
  }

  /** Sets the pump clock to the phone's. */
  syncTime(): Promise<CommandResult> {
    return this.queue.enqueue(async () => {
      try {
        await this.ensureConnected();
      } catch (e) {
        return fail(errorText(e));
      }
      return (await this.syncTimeNow()) ? { ok: true } : fail('The pump time could not be set.');
    });
  }

  // ── uncertain commands ─────────────────────────────────────────────────────

  /** The unresolved command, if any (shown in the recovery UI). */
  pendingCommand(): PendingCommandInfo | null {
    const p = this.state.pending;
    return p ? { kind: p.kind, sentAt: p.sentAt, ...(p.units !== undefined ? { units: p.units } : {}), ...(p.percent !== undefined ? { percent: p.percent } : {}), ...(p.durationMin !== undefined ? { durationMin: p.durationMin } : {}) } : null;
  }

  /** "Check again": reads the bridge's record and the pump's status/history; never sends a dosing command. */
  resolveUncertain(): Promise<ResolveOutcome> {
    return this.queue.enqueue(async () => {
      await this.load();
      return this.resolvePendingNow('user');
    });
  }

  /** The user checked the pump: `delivered` says whether the insulin was given. */
  forceResolve(delivered: boolean): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.load();
      const command = this.state.pending;
      if (!command) return;
      this.clearResolveTimer();
      const now = this.now();
      await this.mutateQuiet((s) => {
        if (s.pending?.requestId !== command.requestId) return s;
        const next = { ...s, pending: null };
        if (!delivered) return next;
        // Count the bolus as given in full on the user's word. It stays tracked, so the pump's own history event
        // for it replaces this amount (same dose id) instead of being imported a second time.
        if (command.kind === 'bolus' && command.units !== undefined && !s.doses.some((d) => d.id === L.bolusDoseId(command.requestId))) {
          const b = { requestId: command.requestId, units: command.units, bolusId: null, sentAt: command.sentAt, acceptedAt: now, automatic: command.automatic, delivered: command.units, missCount: 0, stopped: false };
          return L.trackBolus(next, b);
        }
        return this.adoptDelivered(next, command, null, null, now);
      });
      this.log.info(`Insight: uncertain command resolved by the user (delivered: ${delivered})`);
      this.statusDirty = true;
      await this.refreshAll('user resolved uncertainty');
    });
  }

  // ── alerts, info, pairing ──────────────────────────────────────────────────

  confirmAlert(): Promise<CommandResult> {
    return this.alertCommand('confirm');
  }

  snoozeAlert(): Promise<CommandResult> {
    return this.alertCommand('snooze');
  }

  private alertCommand(action: 'confirm' | 'snooze'): Promise<CommandResult> {
    return this.queue.enqueue(async () => {
      const alert = this.lastStatus?.activeAlert;
      if (!alert) return fail('There is no active pump alert.');
      try {
        await this.ensureConnected();
        if (action === 'confirm') await this.client.confirmAlert(alert.alertId, alert.alertType);
        else await this.client.snoozeAlert(alert.alertId, alert.alertType);
        this.statusDirty = true;
        return { ok: true };
      } catch (e) {
        return fail(errorText(e));
      }
    });
  }

  /** What the settings screen shows (no secrets). */
  info(): InsightPumpInfo {
    const st = this.lastStatus;
    return {
      bridgeId: this.bridgeId,
      connected: this.client.isReady,
      needsRepair: this.client.needsRepair,
      serial: st?.serial ?? this.state.pumpSerial,
      firmware: st?.firmware ?? null,
      pumpLink: st?.pumpLink ?? null,
      operatingMode: st?.operatingMode ?? null,
      activeAlert: st?.activeAlert ?? null,
      profileConfirmed: this.profileConfirmed(),
      profileError: this.profileError,
      pending: this.pendingCommand(),
    };
  }

  /** Reads the pump through the bridge (setup step "check pump"). Throws with a readable message. */
  async checkPump(): Promise<BridgeStatus> {
    return this.queue.enqueue(async () => {
      await this.load();
      try {
        await this.ensureConnected();
        const hello = this.client.hello;
        if (hello && !hello.pumpPaired) throw BridgeError.remote('notPaired');
        const status = await this.client.getStatus();
        await this.applyStatus(status);
        if (status.pumpLink === 'notPaired') throw BridgeError.remote('notPaired');
        return status;
      } catch (e) {
        throw new Error(errorText(e));
      }
    });
  }

  /** Forgets the pairing key and the stored pump state (the bridge keeps its own record). */
  async forgetPairing(): Promise<void> {
    this.clearResolveTimer();
    await this.client.disconnect();
    await deleteCredentials(this.secrets, this.bridgeId);
    await this.secrets.set(stateKey(this.bridgeId), null);
  }
}

export const isInsightDriver = (x: unknown): x is InsightPumpDriver => x instanceof InsightPumpDriver;
