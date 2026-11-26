/**
 * State and synchronisation half of the Insight driver: connection management, status / history
 * reconciliation and the resolution of commands whose outcome is unknown. Port of the sync and
 * uncertainty parts of InsightKit's `InsightPumpManager` (+Sync, +Uncertainty), reduced to what
 * Buddy's `PumpDriver` contract needs. The commands live in driver.ts.
 *
 * Dosing safety rules that every code path here upholds:
 * - a command's pending record is persisted BEFORE it is sent (see driver.ts);
 * - an unresolved record blocks everything that adds insulin; resolving only ever READS
 *   (getRequestOutcome / getStatus / readHistory), it never re-sends a dosing command;
 * - only insulin the pump confirmed reaches the ledger (see ledger.ts);
 * - nothing here logs keys, nonces, raw frames or message bodies.
 */
import {
  createMemorySecretStore,
  newId,
  type Clock,
  type DeviceContext,
  type DeviceMeta,
  type InsulinDose,
  type Logger,
  type Millis,
  type PumpState,
  type SecretStore,
  type TempBasalState,
} from '@buddy/core';
import { secureRandom, type RandomSource } from './bytes';
import { CommandQueue } from './command-queue';
import { SessionBridgeClient, type InsightBridgeClient } from './client';
import { DEFAULT_TIMEOUTS, MAX_CLOCK_SKEW_MS, OUTCOME_BACKOFF_MS, STALE_STATUS_MS, type InsightTimeouts } from './constants';
import { credentialsKey, decodeCredentials, type InsightCredentials } from './credentials';
import {
  bolusStepFor,
  DosingMathError,
  effectiveRate,
  INSIGHT_SPEC,
  parseBasalProfile,
  profileKey as profileKeyOf,
  scheduledRateAt,
  tempSegments,
  type HourlyRates,
} from './dosing-math';
import * as L from './ledger';
import {
  BridgeError,
  isBolusEvent,
  isDelivering,
  pumpUtcOffsetSeconds,
  sanitizeStatus,
  type BridgeEvent,
  type BridgeStatus,
  type HistoryEvent,
  type HistoryPage,
  type JsonValue,
  type RequestOutcome,
  type UnreadableHistoryEvent,
} from './models';
import { emptyPersisted, InsightStateStore, stateKey, type InsightPersisted, type PendingCommand } from './state';
import { applyDeliveredBolus, applyTbrEnd, MAX_PLAUSIBLE_BOLUS } from './history-mapper';
import { reconcileBolus, reconcileMode, reconcileTemp } from './status-reconcile';
import { decidePending, outcomeVerdict } from './uncertainty';

export interface InsightSettings {
  readonly [key: string]: string | number | boolean;
  /** Hex id of the paired bridge (set by pairing). */
  bridgeId: string;
  bridgeName: string;
  /** Last known BLE identifier of the bridge (a starting point only: the address rotates). */
  bridgePeripheral: string;
  /** Pairing key material as JSON (secret; the SecretStore copy takes precedence). */
  pairingSecret: string;
  maxBolus: number;
  maxBasal: number;
  /** 24 hourly basal rates (U/h), or one rate for a flat profile. */
  basalProfile: string;
  autoTimeSync: boolean;
}

export interface InsightDriverOptions {
  /** Replaces the BLE client (tests). */
  readonly client?: InsightBridgeClient;
  readonly timeouts?: Partial<InsightTimeouts>;
  readonly random?: RandomSource;
  readonly appName?: string;
}

export type ResolveOutcome = 'none' | 'delivered' | 'notDelivered' | 'undecided' | 'unreachable';

/** A status read less than this ago is reused by `status()`. */
export const STATUS_FRESH_MS = 60_000;
/** Background refreshes do not retry the connection within this time of a failure. */
const RECONNECT_BACKOFF_MS = 30_000;
/** History older than this is ignored on the very first sync. */
const FIRST_SYNC_LOOKBACK_MS = 8 * 3_600_000;
/** How long an unreadable history event blocks the cursor before it is skipped. */
const UNREADABLE_SKIP_MS = 30 * 60_000;
const INITIAL_HISTORY_WINDOW = 150;
const MAX_HISTORY_PAGES = 20;
const MIN = 60_000;

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const fail = (error: string): { readonly ok: false; readonly error: string } => ({ ok: false, error });

export const UNCERTAIN_TEXT = 'An earlier insulin command has an unknown result. Resolve it before dosing again.';

export abstract class InsightCore {
  protected readonly clock: Clock;
  protected readonly log: Logger;
  protected readonly timeouts: InsightTimeouts;
  protected readonly secrets: SecretStore;
  protected readonly client: InsightBridgeClient;
  protected readonly store: InsightStateStore;
  protected readonly queue = new CommandQueue();
  protected readonly bridgeId: string;
  /** Parsed `basalProfile` setting, `null` + `profileError` when missing or invalid. */
  protected readonly profile: HourlyRates | null;
  protected readonly profileError: string | null;

  protected lastStatus: BridgeStatus | null = null;
  /** Phone clock when `lastStatus` arrived. */
  protected lastStatusReceived: Millis | null = null;
  /** `timestamp` (bridge read time) of the newest applied status. */
  protected lastPumpRead: Millis | null = null;
  /** A command changed what the pump does since the last status read: the cached status is out of date. */
  protected statusDirty = true;
  protected lastHistoryEvents: HistoryEvent[] = [];
  protected lastConnectFailure: Millis | null = null;
  private loaded = false;
  private unreadableSince: Millis | null = null;
  private skippedSequences = new Set<number>();
  private outcomeAttempts = 0;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  protected profileAutoAttempts = 0;
  protected basalMismatchCount = 0;
  protected lastModeCommandAt: Millis | null = null;
  private lastHistoryComplete = false;

  protected constructor(
    readonly meta: DeviceMeta,
    protected readonly settings: InsightSettings,
    ctx: DeviceContext,
    options: InsightDriverOptions = {},
  ) {
    this.clock = ctx.clock;
    this.log = ctx.log;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.bridgeId = String(settings.bridgeId ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{4,64}$/.test(this.bridgeId)) {
      throw new Error('Accu-Chek Insight: no InsightBridge is paired yet. Pair the bridge in the pump setup first.');
    }
    this.secrets = ctx.secrets ?? createMemorySecretStore();
    if (!ctx.secrets) this.log.warn('Insight: no secure storage available; pairing keys and pump state are kept in memory only');
    this.store = new InsightStateStore(this.secrets, stateKey(this.bridgeId), this.log);

    const text = String(settings.basalProfile ?? '').trim();
    let profile: HourlyRates | null = null;
    let profileError: string | null = null;
    if (text) {
      try {
        profile = parseBasalProfile(text);
      } catch (e) {
        profileError = e instanceof DosingMathError ? e.message : 'The basal profile is invalid.';
      }
    } else profileError = 'No basal profile is set. Enter the 24 hourly basal rates in the pump settings.';
    this.profile = profile;
    this.profileError = profileError;

    if (options.client) this.client = options.client;
    else {
      if (!ctx.ble) throw new Error('Accu-Chek Insight needs Bluetooth: no BLE transport is available on this device.');
      this.client = new SessionBridgeClient(
        {
          ble: ctx.ble,
          clock: ctx.clock,
          log: ctx.log,
          timeouts: this.timeouts,
          random: options.random ?? secureRandom,
          appName: options.appName ?? 'Buddy',
          credentials: () => this.loadCredentials(),
          onAdoptPeripheral: (id) => void this.mutate((s) => ({ ...s, peripheralId: id })).catch(() => undefined),
        },
        String(settings.bridgePeripheral ?? '') || null,
      );
    }
    this.client.onEvent((e) => void this.handleEvent(e).catch((err: unknown) => this.log.warn(`Insight: event handling failed (${errorText(err)})`)));
    this.client.onSessionLost(() => {
      this.statusDirty = true;
    });
  }

  protected now(): Millis {
    return this.clock.now();
  }

  protected get state(): InsightPersisted {
    return this.store.current;
  }

  // ── storage ────────────────────────────────────────────────────────────────

  protected async loadCredentials(): Promise<InsightCredentials | null> {
    const stored = decodeCredentials(await this.secrets.get(credentialsKey(this.bridgeId)));
    if (stored && stored.bridgeId.toLowerCase() === this.bridgeId) return stored;
    const fromSetting = decodeCredentials(String(this.settings.pairingSecret ?? ''));
    return fromSetting && fromSetting.bridgeId.toLowerCase() === this.bridgeId ? fromSetting : null;
  }

  protected async load(): Promise<void> {
    if (this.loaded) return;
    const persisted = await this.store.load();
    this.loaded = true;
    if (persisted.peripheralId) this.client.setPeripheral(persisted.peripheralId);
    if (this.state.pending) {
      this.log.warn('Insight: starting with an unresolved insulin command');
      this.scheduleResolve(5_000);
    }
  }

  /** Applies `fn` to the persisted state and writes it if anything changed. Rejects if the write failed. */
  protected async mutate(fn: (s: InsightPersisted) => InsightPersisted): Promise<void> {
    await this.store.load();
    const before = this.store.current;
    const after = fn(before);
    if ((Object.keys(after) as (keyof InsightPersisted)[]).every((k) => after[k] === before[k])) return;
    await this.store.commit(after);
  }

  /** Like `mutate` for non-critical updates: a failed write is logged, not thrown. */
  protected async mutateQuiet(fn: (s: InsightPersisted) => InsightPersisted): Promise<void> {
    try {
      await this.mutate(fn);
    } catch (e) {
      this.log.warn(`Insight: ${errorText(e)}`);
    }
  }

  // ── derived facts ──────────────────────────────────────────────────────────

  protected utcOffsetSeconds(): number {
    const fromPump = pumpUtcOffsetSeconds(this.lastStatus?.pumpTime ?? null);
    return fromPump ?? -new Date(this.now()).getTimezoneOffset() * 60;
  }

  protected maxBolus(): number {
    const lim = this.lastStatus?.limits?.maxBolus;
    return Math.min(Number(this.settings.maxBolus) || INSIGHT_SPEC.maxBolusAbsolute, lim ?? Infinity, INSIGHT_SPEC.maxBolusAbsolute);
  }

  protected maxBasal(): number {
    const lim = this.lastStatus?.limits?.maxBasal;
    return Math.min(Number(this.settings.maxBasal) || INSIGHT_SPEC.maxBasalAbsolute, lim ?? Infinity, INSIGHT_SPEC.maxBasalAbsolute);
  }

  protected bolusStep(units: number): number {
    return bolusStepFor(units, this.lastStatus?.limits?.bolusStep ?? INSIGHT_SPEC.defaultBolusStep);
  }

  /** Scheduled basal rate right now: the profile if known, else what the pump reported. */
  protected scheduledNow(): number | null {
    if (this.profile) return scheduledRateAt(this.profile, this.now(), this.utcOffsetSeconds());
    return this.lastStatus?.basalRate ?? null;
  }

  protected profileConfirmed(): boolean {
    return this.profile !== null && this.state.profileKey === profileKeyOf(this.profile);
  }

  protected runningTempAt(now: Millis): { percent: number; startedAt: Millis; durationMin: number } | null {
    const t = L.activeTemp(this.state, now);
    return t ? { percent: t.percent, startedAt: t.startedAt, durationMin: t.durationMin } : null;
  }

  /** What `PumpDriver.status()` reports, from the newest knowledge. */
  protected snapshotState(): PumpState {
    const st = this.lastStatus;
    const now = this.now();
    const s = this.state;
    let suspended = s.suspended !== null;
    if (st && st.operatingMode !== 'unknown') suspended = !isDelivering(st.operatingMode);

    let tempBasal: TempBasalState | null = null;
    const ours = this.runningTempAt(now);
    if (st && !st.tbrIsUnreadable && !this.statusDirty) {
      if (st.tbr) {
        const base = this.scheduledNow() ?? st.basalRate ?? 0;
        const remaining = Math.min(st.tbr.remaining ?? st.tbr.duration, st.tbr.duration);
        const startedAt = st.tbr.start ?? now - (st.tbr.duration - remaining) * MIN;
        tempBasal = { rate: effectiveRate(st.tbr.percent, base), startedAt, durationMin: st.tbr.duration };
      }
    } else if (ours) {
      const base = this.scheduledNow() ?? 0;
      tempBasal = { rate: effectiveRate(ours.percent, base), startedAt: ours.startedAt, durationMin: ours.durationMin };
    }
    const bolusing = s.bolus !== null || (st !== null && !this.statusDirty && st.boluses.length > 0);
    return {
      reservoirUnits: st?.reservoirUnits ?? null,
      batteryPercent: st?.batteryPercent ?? null,
      suspended,
      tempBasal,
      bolusing,
      bolusIncrement: st?.limits?.bolusStep ?? INSIGHT_SPEC.defaultBolusStep,
      basalIncrement: st?.limits?.basalStep ?? 0.01,
      lastSync: this.lastStatusReceived ?? 0,
      clockOffsetMs: st?.pumpTime?.driftSeconds != null ? st.pumpTime.driftSeconds * 1000 : null,
    };
  }

  // ── connection ─────────────────────────────────────────────────────────────

  /** Brings up a session; throws a certain `BridgeError`. */
  protected async ensureConnected(): Promise<void> {
    try {
      await this.client.ensureSession();
      this.lastConnectFailure = null;
    } catch (e) {
      this.lastConnectFailure = this.now();
      throw e;
    }
  }

  protected canTryReconnect(): boolean {
    return this.client.isReady || this.lastConnectFailure === null || this.now() - this.lastConnectFailure >= RECONNECT_BACKOFF_MS;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private async handleEvent(e: BridgeEvent): Promise<void> {
    switch (e.kind) {
      case 'status':
        await this.applyStatus(e.status);
        break;
      case 'bolusProgress': {
        const b = this.state.bolus;
        if (!b || (b.bolusId !== null && b.bolusId !== e.bolusId) || !(e.delivered >= 0)) return;
        // Progress arrives every couple of seconds: kept in memory, the status re-derives it after a restart.
        this.store.setMemory(L.bolusProgress(this.state, e.delivered, e.bolusId));
        break;
      }
      case 'alert':
        this.log.info(`Insight: pump alert (${e.alert.category})`);
        break;
      default:
        break;
    }
  }

  // ── status ─────────────────────────────────────────────────────────────────

  /** Merges a bridge status into the state. Never blindly trusts an old cached status over newer knowledge. */
  protected async applyStatus(received: BridgeStatus): Promise<{ needsHistory: boolean; bolusEnded: boolean }> {
    await this.load();
    const now = this.now();
    const s = sanitizeStatus(received, now);
    if (s.timestamp === null && received.timestamp !== null) this.log.warn('Insight: a status timestamp from the future was ignored');
    const applied = this.lastPumpRead !== null && this.lastPumpRead <= now + MAX_CLOCK_SKEW_MS ? this.lastPumpRead : null;
    if (s.timestamp !== null && applied !== null && s.timestamp < applied) {
      this.log.info('Insight: ignoring a status older than the one already applied');
      return { needsHistory: false, bolusEnded: false };
    }
    this.lastStatus = s;
    this.lastStatusReceived = now;
    if (s.timestamp !== null) this.lastPumpRead = s.timestamp;
    this.statusDirty = false;

    let bolusEnded = false;
    let needsHistory = false;
    await this.mutateQuiet((st) => {
      let next = st;
      if (s.serial && s.serial.length > 0) {
        if (st.pumpSerial !== null && st.pumpSerial !== s.serial) {
          this.log.warn('Insight: the pump serial changed: treating this as a new pump');
          next = { ...emptyPersisted(), peripheralId: st.peripheralId, pumpSerial: s.serial, doses: st.doses };
        } else if (st.pumpSerial !== s.serial) next = { ...next, pumpSerial: s.serial };
      }
      const bolus = reconcileBolus(next, s, now);
      next = bolus.state;
      bolusEnded = bolus.ended;
      next = reconcileTemp(next, s, now);
      next = reconcileMode(next, s, now, this.lastModeCommandAt);
      const seq = s.lastHistorySequence;
      needsHistory = seq !== null && (next.lastHistorySequence === null || seq > next.lastHistorySequence);
      return L.prune(next, now);
    });
    if (bolusEnded) needsHistory = true;
    return { needsHistory, bolusEnded };
  }

  // ── history ────────────────────────────────────────────────────────────────

  /** Reads and applies new pump history. Returns false when it could not be read. */
  protected async syncHistory(force: boolean): Promise<boolean> {
    await this.load();
    const last = this.state.lastHistorySequence;
    const statusSeq = this.lastStatus?.lastHistorySequence ?? null;
    if (!force && last !== null && statusSeq !== null && statusSeq <= last) {
      this.store.setMemory({ ...this.state, lastHistoryRead: this.now() }); // nothing new: remember that we looked
      return true;
    }
    const since = last ?? (statusSeq !== null ? Math.max(statusSeq - INITIAL_HISTORY_WINDOW, 0) : null);
    try {
      const events: HistoryEvent[] = [];
      const unreadable: UnreadableHistoryEvent[] = [];
      let cursor = since;
      let page: HistoryPage | null = null;
      for (let i = 0; i < MAX_HISTORY_PAGES; i++) {
        page = await this.client.readHistory(cursor);
        events.push(...page.events);
        unreadable.push(...page.unreadable);
        const highest = page.events.reduce((m, e) => Math.max(m, e.seq), -1);
        // Continue only if the page made progress (guards against a bridge that never advances); a waiting
        // safety command must not sit behind a long history read.
        if (!page.more || this.queue.hasSafetyWaiting || highest <= (cursor ?? -1)) break;
        cursor = highest;
      }
      if (!page) return false;
      await this.processHistory(events, unreadable, page.lastSequence, !page.more);
      this.lastHistoryComplete = !page.more;
      return true;
    } catch (e) {
      this.log.warn(`Insight: history read failed (${errorText(e)})`);
      return false;
    }
  }

  protected async processHistory(raw: readonly HistoryEvent[], unreadable: readonly UnreadableHistoryEvent[], pageLast: number, complete: boolean): Promise<void> {
    const now = this.now();
    const current = this.state;
    const seen = new Set<number>();
    let fresh = raw
      .filter((e) => (current.lastHistorySequence === null || e.seq > current.lastHistorySequence) && !this.skippedSequences.has(e.seq) && !seen.has(e.seq) && (seen.add(e.seq), true))
      .sort((a, b) => a.seq - b.seq);
    if (current.lastHistorySequence === null) fresh = fresh.filter((e) => now - e.time <= FIRST_SYNC_LOOKBACK_MS);

    const unreadableSeqs: number[] = [];
    let unknownSeqUnreadable = false;
    let highest: number | null = null;
    let matchedPending = false;

    await this.mutateQuiet((st0) => {
      let st = st0;
      for (const e of fresh) {
        highest = Math.max(highest ?? e.seq, e.seq);
        if (e.kind === 'bolusDelivered') {
          const r = applyDeliveredBolus(st, e);
          st = r.state;
          if (r.unreadable) unreadableSeqs.push(e.seq);
          if (r.matchedPending) matchedPending = true;
        } else if (e.kind === 'tbrEnd') {
          const r = applyTbrEnd(st, e, { profile: this.profile, utcOffsetSeconds: this.utcOffsetSeconds(), driftMs: (this.lastStatus?.pumpTime?.driftSeconds ?? 0) * 1000 });
          st = r.state;
          if (r.unreadable) unreadableSeqs.push(e.seq);
        }
      }
      // An event that could not even be decoded: a bolus with a readable programmed amount counts as delivered in full.
      for (const u of unreadable) {
        if (u.seq !== null) {
          if (this.skippedSequences.has(u.seq)) continue;
          if (u.seq > (st.lastHistorySequence ?? -1)) unreadableSeqs.push(u.seq);
        } else unknownSeqUnreadable = true;
        if (isBolusEvent(u) && u.programmed !== null && u.programmed > 0 && u.programmed <= MAX_PLAUSIBLE_BOLUS) {
          const id = `insight-${st.pumpSerial ?? 'pump'}-unreadable-${u.seq ?? Math.round((u.time ?? now) / 1000)}`;
          if (!st.doses.some((d) => d.id === id)) {
            st = { ...st, doses: [...st.doses, { kind: 'bolus', id, date: u.time ?? now, units: u.programmed }] };
          }
        }
      }
      return st;
    });

    // A permanently unreadable event must not stall history for good: after a while it is skipped.
    let hasUnreadable = unreadableSeqs.length > 0 || unknownSeqUnreadable;
    if (hasUnreadable) {
      this.unreadableSince ??= now;
      if (now - this.unreadableSince > UNREADABLE_SKIP_MS) {
        this.log.warn('Insight: skipping unreadable history events');
        for (const q of unreadableSeqs) this.skippedSequences.add(q);
        this.unreadableSince = now;
        unreadableSeqs.length = 0;
        unknownSeqUnreadable = false;
        hasUnreadable = false;
      }
    } else this.unreadableSince = null;

    this.lastHistoryEvents = fresh;
    const hi = highest as number | null;
    const known = [hi ?? (complete ? pageLast : null), current.lastHistorySequence].filter((x): x is number => x !== null);
    let toStore: number | null = known.length > 0 ? Math.max(...known) : null;
    // Never move past an event that could not be read: it is re-read until the bridge delivers it readable.
    if (unknownSeqUnreadable) toStore = current.lastHistorySequence;
    else if (unreadableSeqs.length > 0) toStore = toStore === null ? null : Math.min(toStore, Math.min(...unreadableSeqs) - 1);
    // While a command is uncertain, keep re-reading everything after the point where it was sent.
    const p = this.state.pending;
    if (p?.isUncertain && p.baselineSequence !== null && toStore !== null) toStore = Math.min(toStore, p.baselineSequence);
    await this.mutateQuiet((st) => ({
      ...st,
      lastHistoryRead: now,
      lastHistorySequence: toStore === null ? st.lastHistorySequence : Math.max(st.lastHistorySequence ?? toStore, toStore),
      pending: matchedPending && st.pending ? { ...st.pending, historyMatched: true } : st.pending,
    }));
  }

  // ── refresh ────────────────────────────────────────────────────────────────

  /** Reads status and new history (inside the command queue's turn). Returns false if the bridge could not be read. */
  protected async refreshAll(reason: string): Promise<boolean> {
    await this.load();
    try {
      const status = await this.client.getStatus();
      const delta = await this.applyStatus(status);
      const force = delta.needsHistory || this.state.bolus !== null || this.state.temp !== null;
      await this.syncHistory(force);
      await this.maybeSyncTime();
      return true;
    } catch (e) {
      this.log.warn(`Insight: refresh failed (${reason}: ${errorText(e)})`);
      return false;
    }
  }

  protected async maybeSyncTime(): Promise<void> {
    if (!this.settings.autoTimeSync) return;
    const st = this.lastStatus;
    const s = this.state;
    if (!st || s.pending || s.bolus) return;
    const drift = Math.abs(st.pumpTime?.driftSeconds ?? 0);
    const offset = pumpUtcOffsetSeconds(st.pumpTime);
    const phoneOffset = -new Date(this.now()).getTimezoneOffset() * 60;
    const zoneMismatch = offset !== null && offset !== phoneOffset;
    const recently = s.lastTimeSync !== null && this.now() - s.lastTimeSync < 3_600_000;
    if (!(drift > 300 || zoneMismatch) || recently) return;
    await this.syncTimeNow();
  }

  protected async syncTimeNow(): Promise<boolean> {
    try {
      const now = this.now();
      await this.client.setDateTime(now, Math.round(-new Date(now).getTimezoneOffset()));
      await this.mutateQuiet((s) => ({ ...s, lastTimeSync: now }));
      this.statusDirty = true;
      return true;
    } catch (e) {
      this.log.warn(`Insight: setting the pump time failed (${errorText(e)})`);
      return false;
    }
  }

  // ── preflight ──────────────────────────────────────────────────────────────

  /**
   * Common checks before a dosing command: a session, a status younger than a minute (read now if
   * needed), the pump reachable and the pump data not older than 15 minutes. Returns the reason
   * to refuse, or `null`. Never throws; nothing is sent to the pump.
   */
  protected async preflight(): Promise<string | null> {
    try {
      await this.ensureConnected();
    } catch (e) {
      return errorText(e);
    }
    const fresh = this.lastStatusReceived !== null && this.now() - this.lastStatusReceived < STATUS_FRESH_MS && !this.statusDirty && this.lastStatus?.pumpLink === 'connected';
    let status = this.lastStatus;
    let onDemand: { readonly previousRead: Millis | null } | null = null;
    if (!fresh || !status) {
      onDemand = { previousRead: this.lastPumpRead };
      try {
        status = await this.client.getStatus();
        await this.applyStatus(status);
        status = this.lastStatus;
      } catch (e) {
        return errorText(e);
      }
    }
    return status ? this.preflightVerdict(status, onDemand) : 'No pump status is available.';
  }

  /** `onDemand`: the status was just asked for (nil: a cached one, which may only say "connected"). */
  private preflightVerdict(status: BridgeStatus, onDemand: { readonly previousRead: Millis | null } | null): string | null {
    if (status.pumpLink === 'notPaired') return BridgeError.remote('notPaired').message;
    if (status.pumpLink !== 'connected') {
      // On-demand bridge mode: a status the bridge read because of our request (strictly newer than anything
      // known before) proves the pump is reachable even if the link is reported down again.
      const read = status.timestamp;
      const readForRequest = onDemand !== null && read !== null && read <= this.now() + MAX_CLOCK_SKEW_MS && (onDemand.previousRead === null || read > onDemand.previousRead);
      if (!readForRequest) return BridgeError.remote('pumpUnreachable').message;
    }
    if (this.isStatusStale()) return 'The pump data is more than 15 minutes old. Insulin is not delivered until the pump has been read again.';
    return null;
  }

  protected isStatusStale(): boolean {
    const dates = [this.lastPumpRead, this.lastStatusReceived].filter((d): d is number => d !== null);
    if (dates.length === 0) return true;
    const age = this.now() - Math.min(...dates);
    // A timestamp from the future (broken clock) counts as stale, never as fresh.
    return age < -MAX_CLOCK_SKEW_MS || age > STALE_STATUS_MS;
  }

  /** nil if the pump's reported basal rate agrees with the profile (or cannot be judged). Two fresh disagreements unconfirm the profile. */
  protected async checkBasalRate(): Promise<string | null> {
    const status = this.lastStatus;
    const profile = this.profile;
    if (!status || !profile || status.basalRate === null || !Number.isFinite(status.basalRate)) return null; // unknown: ignore
    const readAt = status.timestamp ?? this.lastStatusReceived ?? this.now();
    if (this.now() - readAt >= STALE_STATUS_MS) return null;
    const offset = this.utcOffsetSeconds();
    const drift = (status.pumpTime?.driftSeconds ?? 0) * 1000;
    const candidates = [scheduledRateAt(profile, readAt, offset), scheduledRateAt(profile, this.now() + (Number.isFinite(drift) ? drift : 0), offset), scheduledRateAt(profile, this.now(), offset)];
    if (candidates.some((c) => Math.abs(status.basalRate! - c) <= 0.005)) {
      this.basalMismatchCount = 0;
      return null;
    }
    this.basalMismatchCount += 1;
    if (this.basalMismatchCount >= 2) await this.mutateQuiet((s) => ({ ...s, profileKey: null }));
    return `The pump runs ${status.basalRate.toFixed(2)} U/h but the profile says ${candidates[2]!.toFixed(2)} U/h. Sync the basal profile in the pump settings.`;
  }

  // ── uncertain commands ─────────────────────────────────────────────────────

  protected scheduleResolve(afterMs: number): void {
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = null;
      void this.queue.enqueue(() => this.resolvePendingNow('retry')).catch(() => undefined);
    }, afterMs);
    (this.resolveTimer as { unref?: () => void }).unref?.();
  }

  protected clearResolveTimer(): void {
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = null;
  }

  /** Marks the record of `requestId` uncertain (it blocks further dosing until resolved). */
  protected async markUncertain(requestId: string): Promise<void> {
    this.log.warn('Insight: command outcome uncertain');
    await this.mutateQuiet((s) => (s.pending?.requestId === requestId ? { ...s, pending: { ...s.pending, isUncertain: true } } : s));
    this.statusDirty = true;
    this.scheduleResolve(5_000);
  }

  /**
   * Read-only resolution of an uncertain command (never sends a dosing command):
   * 1. the bridge's own record of the request is authoritative when it has a final answer;
   * 2. otherwise status + history are compared with the command.
   */
  protected async resolvePendingNow(reason: string): Promise<ResolveOutcome> {
    await this.load();
    const command = this.state.pending;
    if (!command || !command.isUncertain) return 'none';
    this.log.info(`Insight: resolving an uncertain command (${reason})`);
    try {
      await this.ensureConnected();
    } catch {
      this.scheduleResolve(60_000);
      return 'unreachable';
    }
    let outcome: RequestOutcome | null = null;
    try {
      outcome = await this.client.getRequestOutcome(command.requestId);
    } catch (e) {
      if (!(e instanceof BridgeError && e.kind === 'remote')) {
        this.scheduleResolve(60_000);
        return 'unreachable'; // the answer is just not available right now
      }
      // An older bridge answered with an error: use the evidence path.
    }
    if (outcome) {
      switch (outcomeVerdict(outcome)) {
        case 'delivered':
          return this.settle(command, true, outcome.result, outcome.completedAt);
        case 'notDelivered':
          return this.settle(command, false, null, null);
        case 'inProgress': {
          const delay = OUTCOME_BACKOFF_MS[Math.min(this.outcomeAttempts, OUTCOME_BACKOFF_MS.length - 1)]!;
          this.outcomeAttempts += 1;
          this.scheduleResolve(delay);
          return 'undecided'; // ask again later, never decide
        }
        case 'evidence':
          break;
      }
    }
    return this.resolveFromEvidence(command);
  }

  private async resolveFromEvidence(command: PendingCommand): Promise<ResolveOutcome> {
    let status: BridgeStatus;
    try {
      status = sanitizeStatus(await this.client.getStatus(), this.now());
      await this.applyStatus(status);
    } catch {
      this.scheduleResolve(60_000);
      return 'unreachable';
    }
    this.lastHistoryComplete = false;
    await this.syncHistory(true);
    const current = this.state.pending;
    if (!current || current.requestId !== command.requestId) return 'none';
    let verdict = decidePending(current, status, this.lastHistoryEvents, this.lastHistoryComplete, this.now());
    if (current.historyMatched && current.kind === 'bolus') verdict = 'delivered';
    if (verdict === 'undecided') {
      this.scheduleResolve(60_000);
      return 'undecided';
    }
    return this.settle(current, verdict === 'delivered', null, null);
  }

  private async settle(command: PendingCommand, delivered: boolean, result: JsonValue | null, completedAt: number | null): Promise<ResolveOutcome> {
    this.outcomeAttempts = 0;
    this.clearResolveTimer();
    const now = this.now();
    await this.mutateQuiet((s) => {
      if (s.pending?.requestId !== command.requestId) return s;
      let next: InsightPersisted = { ...s, pending: null };
      if (delivered) next = this.adoptDelivered(next, command, result, completedAt, now);
      else this.log.info('Insight: the uncertain command was not executed');
      return next;
    });
    this.statusDirty = true;
    void this.refreshAll('uncertain command resolved');
    return delivered ? 'delivered' : 'notDelivered';
  }

  /** The command did run: make the records match. */
  protected adoptDelivered(st: InsightPersisted, command: PendingCommand, result: JsonValue | null, completedAt: number | null, now: Millis): InsightPersisted {
    const obj = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : {};
    switch (command.kind) {
      case 'bolus': {
        const units = command.units;
        if (units === undefined) return st;
        if (st.doses.some((d) => d.id === L.bolusDoseId(command.requestId)) || st.bolus?.requestId === command.requestId) return st; // history already delivered it
        const bolusId = typeof obj.bolusId === 'number' && Number.isSafeInteger(obj.bolusId) ? obj.bolusId : null;
        if (bolusId !== null && st.knownBoluses.some((k) => k.bolusId === bolusId)) return st;
        const active = this.lastStatus?.boluses.find((b) => Math.abs(b.amount - units) < 0.005 && !st.knownBoluses.some((k) => k.bolusId === b.bolusId));
        if (!active && bolusId === null) return st; // no handle: the pump history will carry the dose
        const b = {
          requestId: command.requestId,
          units,
          bolusId: active?.bolusId ?? bolusId,
          sentAt: command.sentAt,
          acceptedAt: completedAt ?? now,
          automatic: command.automatic,
          delivered: active ? Math.max(units - active.remaining, 0) : 0,
          missCount: 0,
          stopped: false,
        };
        return L.trackBolus(st, b);
      }
      case 'setTBR': {
        if (st.temp?.requestId === command.requestId) return st;
        const percent = typeof obj.percent === 'number' ? obj.percent : command.percent;
        const minutes = typeof obj.duration === 'number' ? obj.duration : command.durationMin;
        if (percent === undefined || minutes === undefined || percent < 0 || percent > INSIGHT_SPEC.tbrMaxPercent || minutes < 1 || minutes > INSIGHT_SPEC.tbrMaxMinutes) return st;
        return this.recordTemp(st, command.requestId, percent, minutes, command.sentAt, command.scheduledRate ?? this.scheduledNow() ?? 0);
      }
      case 'cancelTBR':
        return L.endTemp(st, command.sentAt);
      case 'suspend':
        this.lastModeCommandAt = command.sentAt;
        return L.suspend(st, command.sentAt, `insight-suspend-${command.requestId}`);
      case 'resume':
        this.lastModeCommandAt = command.sentAt;
        return L.resume(st, command.sentAt);
    }
  }

  /** Records a confirmed temp basal (segments follow the profile hour by hour). */
  protected recordTemp(st: InsightPersisted, requestId: string, percent: number, minutes: number, startedAt: Millis, scheduledRate: number): InsightPersisted {
    const segs = tempSegments(percent, startedAt, minutes, this.profile, this.utcOffsetSeconds(), scheduledRate);
    const ids = L.tempDoseIds(L.tempBaseId(requestId), segs.length);
    return L.startTemp(st, { requestId, percent, startedAt, durationMin: minutes, segmentIds: ids }, segs);
  }

  /** The id for a new command (unique per user/loop intent). */
  protected newRequestId(kind: string): string {
    return newId(kind);
  }
}

export const doseTotal = (doses: readonly InsulinDose[]): number => doses.reduce((n, d) => (d.kind === 'bolus' || d.kind === 'smb' ? n + d.units : n), 0);
