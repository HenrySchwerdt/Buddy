import { fromHex, hex } from '@buddy/core';
import { MEDTRUM_INSULIN_STEP } from './bytes';
import { genSessionToken } from './crypto';
import { DoseLedger } from './dose-ledger';
import { PatchState, basalType, patchState, patchStateName } from './enums';
import { MEDTRUM_SERVICE_UUID, MedtrumLink, describeWriteError } from './link';
import { SynchronizePacket, validated } from './notification-packet';
import { AuthorizePacket, GetTimePacket, SubscribePacket } from './packets';
import { loadSession, saveSession, sessionKey } from './session';
import { baseResetCheck, deliveryStoppedAt, maxBasalRateForModel, modelFromSerial } from './state-syncer';
const MIN = 60_000;
/** background sync, doesn't lock loops */
export const HEARTBEAT_SYNC_FRESHNESS_MS = 2.5 * MIN;
/** start of the loop, try to avoid syncs */
export const LOOP_SYNC_FRESHNESS_MS = 4.5 * MIN;
export const PATCH_TIME_REFRESH_MS = 30 * MIN;
/**
 * A pending bolus is settled (as uncertain) after this many statuses on a live link that show no
 * bolus in progress.
 */
export const BOLUS_IDLE_STATUSES_TO_RESOLVE = 3;
/** `estimatedDuration(toBolus:)`: 1.5 U per minute, plus a minute of slack. */
export const expectedBolusEndMs = (requested, sentAt) => sentAt + (requested / 1.5) * MIN + MIN;
export class MedtrumError extends Error {
}
export class MedtrumNanoCore {
    settings;
    ble;
    secrets;
    clock;
    log;
    opts;
    /** As stored by MedtrumKit: fromHex(serial), e.g. [0xAA, 0x76, 0xF9, 0xD9]. */
    pumpSN;
    model;
    session;
    ledger;
    loading = null;
    conn = null;
    link = null;
    ready = false;
    queue = Promise.resolve();
    saving = Promise.resolve();
    fullSyncQueued = false;
    /** While the patch is being stopped on request, the states it reports are not a base reset */
    isDeactivatingPatch = false;
    /** SetBolus written, answer not yet in: statuses cannot tell anything about this bolus yet. */
    bolusCommandInFlight = false;
    /** SetTempBasal written, answer not yet in: keep the pending temp until the outcome is known. */
    tempCommandInFlight = false;
    bolusIdleStatuses = 0;
    constructor(settings, ctx, options = {}) {
        this.settings = settings;
        if (!ctx.ble)
            throw new Error('Medtrum Nano needs Bluetooth: DeviceContext.ble is missing');
        if (!ctx.secrets)
            throw new Error('Medtrum Nano needs secure storage for the patch session: DeviceContext.secrets is missing');
        this.ble = ctx.ble;
        this.secrets = ctx.secrets;
        this.clock = ctx.clock;
        this.log = ctx.log;
        this.opts = {
            writeTimeoutMs: options.writeTimeoutMs ?? 30_000,
            connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
            scanTimeoutMs: options.scanTimeoutMs ?? 15_000,
            utcOffsetSeconds: options.utcOffsetSeconds ?? ((at) => -new Date(at).getTimezoneOffset() * 60),
            suspendMinutes: options.suspendMinutes ?? 120,
        };
        const sn = parseSerial(settings.serialNumber);
        this.pumpSN = sn;
        this.model = sn ? modelFromSerial(sn) : 'INVALID';
    }
    get maxBasalRate() {
        return maxBasalRateForModel(this.model);
    }
    get isConnected() {
        return this.ready && this.link?.isOpen === true;
    }
    // ── plumbing ───────────────────────────────────────────────────────────────
    /** One command in flight at a time. */
    serialize(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }
    now() {
        return this.clock.now();
    }
    async load() {
        if (!this.loading) {
            this.loading = (async () => {
                if (!this.pumpSN)
                    throw new MedtrumError('Invalid Medtrum serial number (8 hex digits expected)');
                if (this.model === 'INVALID')
                    throw new MedtrumError('Incorrect serial number: not a known Medtrum Nano base');
                this.session = await loadSession(this.secrets, sessionKey(hex(this.pumpSN)));
                this.ledger = new DoseLedger(this.session.ledger);
            })();
            this.loading.catch(() => {
                this.loading = null;
            });
        }
        return this.loading;
    }
    update(patch) {
        this.session = { ...this.session, ...patch };
    }
    /** Writes the session (and dose ledger) to the secret store. Writes are queued in order. */
    persist() {
        const sn = this.pumpSN;
        if (!sn || !this.session)
            return this.saving;
        const snapshot = { ...this.session, ledger: this.ledger.snapshot(this.now()) };
        this.saving = this.saving
            .then(() => saveSession(this.secrets, sessionKey(hex(sn)), snapshot))
            .catch((e) => this.log.error(`Medtrum: failed to persist session: ${String(e)}`));
        return this.saving;
    }
    async send(packet) {
        const link = this.link;
        if (!link?.isOpen)
            return { ok: false, error: { kind: 'notSent', message: 'not connected' } };
        return link.writePacket(packet);
    }
    // ── connection (BluetoothManager.ensureConnected + PeripheralManager auth flow) ──
    async ensureConnected() {
        await this.load();
        if (this.isConnected)
            return;
        this.dropConnection();
        const state = await this.ble.state();
        if (state !== 'poweredOn')
            throw new MedtrumError(`Bluetooth is ${state}`);
        let deviceId = this.session.deviceId;
        let conn = null;
        if (deviceId) {
            try {
                conn = await this.ble.connect(deviceId, { timeoutMs: this.opts.connectTimeoutMs });
            }
            catch (e) {
                this.log.warn(`Medtrum: reconnect to known base failed (${String(e)}), scanning`);
                conn = null;
            }
        }
        if (!conn) {
            deviceId = await this.scanForBase();
            conn = await this.ble.connect(deviceId, { timeoutMs: this.opts.connectTimeoutMs });
        }
        this.conn = conn;
        const link = new MedtrumLink(conn, {
            writeTimeoutMs: this.opts.writeTimeoutMs,
            log: this.log,
            onStatus: (s) => this.onHeartbeat(link, s),
            onDisconnect: (e) => this.onLinkLost(link, e),
        });
        this.link = link;
        try {
            await link.start();
            await this.authorize();
            // Connect step 2
            const sync = await this.send(new SynchronizePacket());
            if (!sync.ok)
                throw new MedtrumError(`Failed to synchronize: ${describeWriteError(sync.error)}`);
            this.applyStatus(sync.data, { duringReconnect: true, fullSync: true });
            // Connect step 4 (last)
            const sub = await this.send(new SubscribePacket());
            if (!sub.ok)
                throw new MedtrumError(`Failed to subscribe: ${describeWriteError(sub.error)}`);
            if (!link.isOpen)
                throw new MedtrumError('Connection lost while connecting');
            this.ready = true;
            if (this.session.deviceId !== deviceId)
                this.update({ deviceId });
            await this.persist();
            this.log.info('Medtrum: Connected to pump!');
        }
        catch (e) {
            this.dropConnection();
            throw e;
        }
    }
    // Connect step 1
    async authorize() {
        const sn = this.pumpSN;
        const first = await this.send(new AuthorizePacket(sn, fromHex(this.session.sessionToken)));
        let result = first;
        if (!first.ok) {
            this.log.warn('Medtrum: Failed to complete authorization flow, falling back to backup token');
            result = await this.send(new AuthorizePacket(sn, fromHex(this.session.backupSessionToken)));
        }
        if (!result.ok)
            throw new MedtrumError(`Failed to complete authorization flow: ${describeWriteError(result.error)}`);
        this.update({ deviceType: result.data.deviceType, swVersion: result.data.swVersion });
    }
    async scanForBase() {
        const sn = this.pumpSN;
        // The base advertises its serial little-endian (manufacturer data bytes 2..5)
        const advertised = sn.slice().reverse();
        let found = null;
        await this.ble.scan({ timeoutMs: this.opts.scanTimeoutMs }, (ad) => {
            if (found || ad.name !== 'MT')
                return;
            const md = ad.manufacturerData;
            // Index: 0 & 1 -> Manufacturer ID, 2-5 -> PumpSN, 6 -> Device type, 7 -> Version
            if (!md || md.length < 7)
                return;
            if (advertised.every((b, i) => md[2 + i] === b)) {
                found = ad.id;
                this.ble.stopScan();
            }
        });
        if (!found)
            throw new MedtrumError(`Medtrum base ${hex(sn).toUpperCase()} not found`);
        return found;
    }
    dropConnection() {
        const link = this.link;
        const conn = this.conn;
        this.link = null;
        this.conn = null;
        this.ready = false;
        link?.invalidate();
        if (conn)
            conn.disconnect().catch(() => undefined);
    }
    onLinkLost(link, e) {
        if (this.link !== link)
            return;
        this.log.warn(`Medtrum: Device disconnected${e ? `: ${e.message}` : ''}`);
        this.link = null;
        this.conn = null;
        this.ready = false;
    }
    onHeartbeat(link, s) {
        if (this.link !== link || !this.session)
            return;
        this.applyStatus(s, { duringReconnect: false, fullSync: false });
        void this.persist();
        this.considerFullSync();
    }
    considerFullSync() {
        if (!this.ready || this.fullSyncQueued)
            return;
        if (this.now() - this.session.lastSync <= HEARTBEAT_SYNC_FRESHNESS_MS)
            return;
        const p = this.ledger.pendingBolus;
        // Skipping sync, pump is currently bolusing - unless the bolus should long be over (stuck)
        if (p && this.now() < expectedBolusEndMs(p.requested, p.sentAt))
            return;
        this.fullSyncQueued = true;
        void this.serialize(async () => {
            try {
                if (this.isConnected)
                    await this.fullSync();
            }
            catch (e) {
                this.log.error(`Medtrum: Failed to synchronize: ${String(e)}`);
            }
            finally {
                this.fullSyncQueued = false;
            }
        });
    }
    /** SYNCHRONIZE + apply; also refreshes the patch clock if stale. Returns false on failure. */
    async fullSync() {
        const r = await this.send(new SynchronizePacket());
        if (!r.ok) {
            this.log.error(`Medtrum: Failed to synchronize: ${describeWriteError(r.error)}`);
            return false;
        }
        this.applyStatus(r.data, { duringReconnect: false, fullSync: true });
        if (this.now() - (this.session.pumpTimeSyncedAt ?? 0) > PATCH_TIME_REFRESH_MS)
            await this.fetchPatchTime();
        await this.persist();
        return true;
    }
    async fetchPatchTime() {
        const r = await this.send(new GetTimePacket());
        if (!r.ok) {
            this.log.warn(`Medtrum: Failed to get current Patch time: ${describeWriteError(r.error)}`);
            return;
        }
        this.update({ pumpTime: r.data.time, pumpTimeSyncedAt: this.now() });
    }
    async ensureConnectedAndActive() {
        await this.load();
        if (patchState.isSetup(this.session.pumpState))
            throw new MedtrumError('No active patch');
        await this.ensureConnected();
        if (patchState.isSetup(this.session.pumpState))
            throw new MedtrumError('No active patch');
    }
    // ── StateSyncer.sync ───────────────────────────────────────────────────────
    applyStatus(raw, o) {
        const now = this.now();
        const s = this.session;
        // Checked on the payload as received: a rebooted base reports a new patch id, and validation
        // would strip exactly the fields that tell a reset apart - and when it happened
        const check = baseResetCheck(raw, s);
        if (check === 'reset' && !this.isDeactivatingPatch) {
            // Nothing else in this payload describes the patch we knew
            this.handleBaseReset(deliveryStoppedAt(raw, s, now));
            return;
        }
        if (check === 'unconfirmed') {
            // `.none` is also what an unknown state byte parses to, don't drop an activated patch over it
            this.log.warn('Medtrum: Activated patch reported state none without a new patch id, ignoring');
            return;
        }
        // No session: the id kept can be stale and would reject the new patch's payloads.
        const expectedPatchId = s.patchSessionEnded ? 0 : (s.patchId ?? 0);
        const r = validated(raw, expectedPatchId);
        if (r.invalidPayload)
            this.log.error('Medtrum: Rejecting mismatched notification payload');
        if (r.state !== s.pumpState) {
            this.log.info(`Medtrum: patch state ${patchStateName(s.pumpState)} -> ${patchStateName(r.state)}`);
            if (patchState.isFault(r.state) || r.state === PatchState.baseFault || r.state === PatchState.hourlyMaxSuspended || r.state === PatchState.dailyMaxSuspended) {
                this.log.error(`Medtrum ALERT: patch is ${patchStateName(r.state)}`);
            }
        }
        this.update({ pumpState: r.state });
        const hasActivatedPatch = r.state >= PatchState.active;
        if (r.reservoir !== undefined) {
            this.update({ reservoir: r.reservoir });
            if (hasActivatedPatch && this.session.initialReservoir === null)
                this.update({ initialReservoir: r.reservoir });
        }
        let changed = false;
        if (patchState.isDeliveryHalted(r.state)) {
            // a halted state is authoritative even when the notification carries a cached basal.
            changed = this.recordSuspendIfDelivering(r, now) || changed;
            this.update({ basalState: 'suspended' });
        }
        else if (r.basal) {
            if (basalType.isTempBasal(r.basal.type)) {
                changed = this.adoptRunningTempBasal(r.basal.rate, r.basal.startTime, now) || changed;
                this.update({ basalState: 'tempBasal' });
            }
            else if (basalType.isSuspendedByPump(r.basal.type)) {
                changed = this.recordSuspendIfDelivering(r, now) || changed;
                this.update({ basalState: 'suspended' });
            }
            else {
                // The patch is delivering on its schedule again
                changed = this.ledger.endTempBasal(now) || changed;
                changed = this.ledger.resume(now) || changed;
                if (this.ledger.pendingTempBasal && !this.tempCommandInFlight) {
                    this.log.warn('Medtrum: unconfirmed temp basal is not running on the patch, dropping it');
                    this.ledger.setPendingTempBasal(null);
                }
                this.update({ basalState: 'active' });
            }
        }
        if (r.primeProgress !== undefined)
            this.update({ primeProgress: r.primeProgress });
        if (r.battery)
            this.update({ battery: r.battery.voltageB });
        if (r.startTime !== undefined)
            this.update({ patchActivatedAt: r.startTime });
        if (r.storage) {
            // No session: the old patch can report its id until it disconnects. A running patch with another id is the new
            // one, its session not started.
            const id = r.storage.patchId;
            const cur = this.session;
            if (!cur.patchSessionEnded || (patchState.isRunning(r.state) && id !== cur.previousPatch?.patchId))
                this.update({ patchId: id });
        }
        if (r.bolus) {
            const p = this.ledger.pendingBolus;
            if (!p) {
                if (r.bolus.completed && this.ledger.uncertainBolus && this.ledger.correctUncertainBolus(r.bolus.delivered)) {
                    this.log.warn(`Medtrum: uncertain bolus corrected to the reported ${r.bolus.delivered} U`);
                    changed = true;
                }
            }
            else if (!p.confirmed && r.bolus.completed && !o.fullSync) {
                // DEVIATION: a heartbeat can still carry the previous bolus' final record before the patch
                // answered SetBolus; only a full sync may settle an unconfirmed bolus as completed.
                this.log.warn('Medtrum: ignoring completed bolus report for an unconfirmed bolus outside a full sync');
                changed = this.noteBolusIdle() || changed;
            }
            else {
                if (!r.bolus.completed)
                    this.bolusIdleStatuses = 0;
                changed = this.updateBolusProgress(r.bolus.delivered, r.bolus.completed) || changed;
            }
        }
        else if (o.duringReconnect) {
            changed = this.checkBolusDone() || changed;
        }
        else {
            changed = this.noteBolusIdle() || changed;
        }
        if (o.fullSync || changed)
            this.update({ lastSync: now });
    }
    /** A temp basal is running on the patch: keep ours, adopt an unconfirmed one, or record an unknown one. */
    adoptRunningTempBasal(rate, startTime, now) {
        // The SetTempBasal answer is still on its way and settles this itself.
        if (this.tempCommandInFlight)
            return false;
        const seg = this.ledger.basal;
        if (seg.kind === 'temp' && Math.abs(seg.rate - rate) < 0.001)
            return this.ledger.extendOpenTempBasal(now);
        const pending = this.ledger.pendingTempBasal;
        const start = startTime <= now && startTime >= (pending?.sentAt ?? now) - MIN ? startTime : now;
        if (pending && Math.abs(pending.rate - rate) < 0.001) {
            this.log.warn(`Medtrum: adopting temp basal ${rate} U/h whose confirmation was lost`);
            this.ledger.startTempBasal(rate, pending.durationMin, start);
            return true;
        }
        // DEVIATION: Swift only flips basalState. Buddy records what the patch says it delivers; the
        // duration is unknown, so the record is open-ended: extended (same dose id) by every status
        // that still shows it running, and closed by the first one that shows the schedule again.
        this.log.error(`Medtrum: patch runs an unknown temp basal of ${rate} U/h`);
        this.ledger.startOpenTempBasal(rate, start, now);
        return true;
    }
    recordSuspendIfDelivering(r, now) {
        if (this.ledger.basal.kind === 'suspended')
            return false;
        // accurate time would require pump-history reconciliation
        const b = r.basal;
        const at = b && basalType.isSuspendedByPump(b.type) && b.startTime >= this.ledger.basal.since && b.startTime <= now ? b.startTime : now;
        return this.ledger.suspend(at);
    }
    /** `updateBolusProgress` */
    updateBolusProgress(delivered, completed) {
        const p = this.ledger.pendingBolus;
        if (!p)
            return false;
        if (!this.ledger.bolusProgress(delivered, completed)) {
            this.log.error(`Medtrum: ignoring bolus report of ${delivered} U for a ${p.requested} U bolus`);
            return false;
        }
        if (completed)
            this.log.info(`Medtrum: bolus complete, ${delivered} U delivered`);
        return true;
    }
    /**
     * `checkBolusDone`: a bolus was pending across a reconnect and the patch reports no bolus.
     * As in Swift, it is assumed to have completed: the requested amount is recorded (over-reporting
     * IOB errs toward less insulin) and corrected if a later status reports the delivered amount.
     */
    checkBolusDone() {
        const p = this.ledger.pendingBolus;
        if (!p)
            return false;
        this.log.error(`Medtrum: Bolus was not completed... ${p.delivered} U of the ${p.requested} U seen; recording ${p.requested} U (delivery uncertain)`);
        this.ledger.finalizeBolusUncertain();
        this.bolusIdleStatuses = 0;
        return true;
    }
    /**
     * A status on a live link shows no bolus in progress while one is pending. After a few of them
     * the bolus is settled like `checkBolusDone` (it is not running any more, amount unknown).
     */
    noteBolusIdle() {
        if (!this.ledger.pendingBolus || this.bolusCommandInFlight)
            return false;
        this.bolusIdleStatuses += 1;
        if (this.bolusIdleStatuses < BOLUS_IDLE_STATUSES_TO_RESOLVE)
            return false;
        this.log.error('Medtrum: pending bolus not reported in progress by the patch');
        return this.checkBolusDone();
    }
    resetBolusIdle() {
        this.bolusIdleStatuses = 0;
    }
    // ── patch session (MedtrumPumpManager start/endPatchSession, handleBaseReset) ──
    /** The base rebooted underneath an activated patch: the session cannot be resumed, so it ends here. */
    handleBaseReset(stoppedAt) {
        this.log.error(`Medtrum ALERT: Pump base has reset, patch session is lost - delivery stopped at ${new Date(stoppedAt).toISOString()}`);
        this.endPatchSession(stoppedAt, false);
        this.dropConnection();
        void this.persist();
    }
    /**
     * The new patch delivers on its schedule from `start` - unless it is not delivering: then the
     * suspend stays outstanding, for the first status that shows it delivering to resume.
     */
    startPatchSession(patchId, start, activatedAt, isDelivering) {
        if (!this.session.patchSessionEnded) {
            // The previous patch was replaced without deactivating it: it is taken to have delivered until `start`
            this.log.warn('Medtrum: Previous patch session was not ended, ending its delivery at activation');
            this.ledger.endTempBasal(start);
            this.finalizeInterruptedBolus();
        }
        if (isDelivering) {
            this.ledger.resume(start);
            this.update({ basalState: 'active' });
        }
        else {
            this.update({ basalState: 'suspended' });
        }
        this.update({ patchSessionEnded: false, initialReservoir: null, patchId, patchActivatedAt: activatedAt, lastSync: this.now() });
    }
    /** The patch session is over: delivery stopped at `stoppedAt`, unless it is known to have stopped already */
    endPatchSession(deliveryStoppedAtMs, statusIsCurrent) {
        // Delivery cannot have stopped before the running dose began
        const stoppedAt = Math.max(deliveryStoppedAtMs, this.ledger.basal.since);
        const s = this.session;
        if (!s.patchSessionEnded) {
            this.update({
                previousPatch: {
                    patchId: s.patchId,
                    lastState: s.pumpState,
                    lastSyncAt: s.lastSync,
                    activatedAt: s.patchActivatedAt,
                    deactivatedAt: stoppedAt,
                    reservoirLevel: s.reservoir,
                },
            });
        }
        const hasStopped = this.ledger.basal.kind === 'suspended' &&
            (patchState.isTerminated(s.pumpState) || patchState.isSetup(s.pumpState) || (statusIsCurrent && !patchState.isDelivering(s.pumpState)));
        if (!hasStopped) {
            this.ledger.endTempBasal(stoppedAt);
            this.ledger.suspend(stoppedAt);
        }
        this.finalizeInterruptedBolus();
        this.update({
            patchId: null,
            pumpState: PatchState.none,
            backupSessionToken: s.sessionToken,
            sessionToken: '',
            initialReservoir: null,
            patchSessionEnded: true,
            lastSync: this.now(),
            basalState: 'suspended',
        });
    }
    finalizeInterruptedBolus() {
        const p = this.ledger.pendingBolus;
        if (!p)
            return;
        this.log.error(`Medtrum: Patch session ended during a bolus... ${p.delivered} U of the ${p.requested} U seen; recording ${p.requested} U (delivery uncertain)`);
        this.ledger.finalizeBolusUncertain();
    }
    ensureSessionToken() {
        if (this.session.sessionToken === '') {
            // Patch has been disabled and thus a new session token is needed
            this.update({ sessionToken: hex(genSessionToken()) });
        }
    }
    // ── status ─────────────────────────────────────────────────────────────────
    snapshotState() {
        const s = this.session;
        const now = this.now();
        const temp = s.basalState === 'suspended' ? null : this.ledger.tempBasalActiveAt(now);
        return {
            reservoirUnits: s.reservoir,
            // Patch pumps do not report a battery percentage (only the voltage)
            batteryPercent: null,
            suspended: s.basalState === 'suspended' || !patchState.isRunning(s.pumpState),
            tempBasal: temp ? { rate: temp.rate, startedAt: temp.since, durationMin: temp.durationMin } : null,
            bolusing: this.ledger.pendingBolus !== null,
            bolusIncrement: MEDTRUM_INSULIN_STEP,
            basalIncrement: MEDTRUM_INSULIN_STEP,
            lastSync: s.lastSync,
        };
    }
}
export function parseSerial(serial) {
    if (typeof serial !== 'string')
        return null;
    const s = serial.trim();
    return /^[0-9a-fA-F]{8}$/.test(s) ? fromHex(s) : null;
}
export { MEDTRUM_SERVICE_UUID };
