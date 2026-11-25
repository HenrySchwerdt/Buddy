import { DoseLedger } from './ledger';
import { attributeRecords, bolusDose, COMPLETION_OVERDUE_MS, FINGERPRINT_RETENTION_MS, fingerprintOf, historyRecordId, MATCH_SKEW_MS, UNCERTAIN_GRACE_MS, } from './bolus-tracker';
import { DEFAULT_TIMEOUTS, openLink, parsePincodes } from './link';
import { EncryptionType } from './packet-type';
import { danaBasalCancelTemporary, danaBasalGetRate, danaBasalSetSuspendOff, danaBasalSetSuspendOn, danaBasalSetTemporary, danaBolusStart, danaBolusStop, danaGeneralGetInitialScreenInformation, danaGeneralGetPumpTime, danaGeneralGetPumpTimeUtcWithTimezone, danaGeneralKeepConnection, danaGeneralSetHistoryUploadMode, danaGeneralSetPumpTime, danaGeneralSetPumpTimeUtcWithTimezone, danaHistoryAll, danaLoopSetTemporaryBasal, HistoryCode, parseNotifyAlarm, parseNotifyDeliveryComplete, parseNotifyDeliveryRateDisplay, secondsPerUnit, transformBolusError, } from './packets';
import { usingUtc } from './peripheral';
import { bytesOrEmpty, hexOrUndefined } from './persisted';
import { absoluteBasalRateToPercentage, splitTempAtHours, BASAL_INCREMENT, BOLUS_INCREMENT, percentToRate, planTempBasal, roundToSupportedBolusVolume, scheduledBasalRate, } from './temp-basal';
/** `ensureCurrentPumpData`: history is re-read when older than this. */
const HISTORY_STALE_MS = 4 * 60_000;
/** How long cancelBolus waits for the final DELIVERY_COMPLETE after the stop was accepted. */
const STOP_SETTLE_MS = 3_000;
/** A screen refresh younger than this is reused within one command. */
const SCREEN_FRESH_MS = 2_000;
const errorText = (e) => (e instanceof Error ? e.message : String(e));
const fail = (error) => ({ ok: false, error });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class DanaPumpDriver {
    meta;
    config;
    ble;
    store;
    clock;
    log;
    session;
    timeouts;
    link = null;
    queue = Promise.resolve();
    loaded = false;
    screen = null;
    screenAt = 0;
    basalProfile = [];
    lastSync = 0;
    lastHistorySync = 0;
    ledger;
    bolusState = null;
    seenHistory = new Set();
    /** Pump clock minus phone clock, from the last pump-time read (ms). */
    pumpClockOffset = 0;
    pincodeResolver = null;
    pincodeListeners = new Set();
    constructor(meta, config, ble, store, clock, log) {
        this.meta = meta;
        this.config = config;
        this.ble = ble;
        this.store = store;
        this.clock = clock;
        this.log = log;
        this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
        this.session = {
            deviceName: config.deviceName.toUpperCase(),
            encryptionMode: config.expectedModel === 'dana-i' ? EncryptionType.BLE_5 : config.expectedModel === 'dana-rs' ? EncryptionType.RSv3 : EncryptionType.DEFAULT,
            hwModel: 0,
            pumpProtocol: 0,
            randomSyncKey: 0,
            pairingKey: new Uint8Array(0),
            randomPairingKey: new Uint8Array(0),
            ble5Keys: new Uint8Array(0),
            ignorePassword: false,
            isConnected: false,
            isInFetchHistoryMode: false,
        };
        this.ledger = new DoseLedger(`dana-${this.session.deviceName}`, () => this.clock.now(), (at) => scheduledBasalRate(this.basalProfile, at));
    }
    // ── PumpDriver ────────────────────────────────────────────────────────────────
    connect() {
        return this.serial(async () => {
            await this.ensureConnected();
            try {
                await this.backgroundSync();
            }
            catch (e) {
                this.log.warn(`Dana: post-connect sync failed: ${errorText(e)}`);
            }
        });
    }
    disconnect() {
        return this.serial(async () => {
            const l = this.link;
            this.dropLink();
            if (l) {
                l.peripheral.close(new Error('Disconnected by user'));
                await l.conn.disconnect().catch(() => { });
            }
        });
    }
    status() {
        return this.serial(async () => {
            const now = this.clock.now();
            if (this.bolusRunningAndOnTime(now))
                return this.buildState(now);
            try {
                await this.prepare();
                await this.backgroundSync();
            }
            catch (e) {
                this.log.warn(`Dana: status refresh failed, reporting cached state: ${errorText(e)}`);
            }
            return this.buildState(this.clock.now());
        });
    }
    setTempBasal(rate, durationMin) {
        return this.serial(async () => {
            if (!Number.isFinite(rate) || rate < 0)
                return fail(`Invalid temp basal rate ${rate}`);
            if (!Number.isFinite(durationMin))
                return fail(`Invalid temp basal duration ${durationMin}`);
            if (durationMin <= 0)
                return this.doCancelTempBasal();
            if (this.bolusState)
                return fail('Rejecting command -> Pump is bolussing...');
            try {
                await this.prepare();
            }
            catch (e) {
                return fail(`No connection: ${errorText(e)}`);
            }
            const screen = this.screen;
            if (!screen)
                return fail('No pump status available');
            if (screen.isPumpSuspended)
                return fail('Pump is suspended');
            if (this.basalProfile.length !== 24)
                await this.fetchBasalProfile();
            if (this.basalProfile.length !== 24)
                return fail('Basal schedule is not available...');
            const now = this.clock.now();
            const percentage = absoluteBasalRateToPercentage(rate, this.basalProfile, now, durationMin);
            if (percentage === null)
                return fail('Basal schedule is not available (or the scheduled basal is 0 U/h)...');
            const plan = planTempBasal(percentage, durationMin);
            if (!plan.ok)
                return fail(plan.error);
            try {
                if (screen.isTempBasalInProgress) {
                    const cancel = await this.send(danaBasalCancelTemporary());
                    if (!cancel.success)
                        return fail('Could not cancel old temp basal');
                    this.ledger.recordTempEnd(now);
                    this.screen = { ...screen, isTempBasalInProgress: false };
                    this.log.info('Dana: successfully canceled old temp basal');
                }
            }
            catch (e) {
                return fail(`Failed to cancel old temp basal: ${errorText(e)}`);
            }
            const packet = plan.command.kind === 'short'
                ? danaLoopSetTemporaryBasal({ percent: plan.percent, duration: plan.command.code })
                : danaBasalSetTemporary({ temporaryBasalRatio: plan.percent, temporaryBasalDuration: plan.command.hours });
            // Highest rate the pump runs in this window (equals the request for a flat profile)
            // What the pump runs: percent × each profile hour's scheduled rate (never above the request)
            const segments = splitTempAtHours(plan.percent, this.basalProfile, now, plan.durationMin);
            let result;
            try {
                result = await this.send(packet);
            }
            catch (e) {
                // No answer: ask the pump whether the temp is running before giving up
                if (await this.verifyTempRunning(plan.percent))
                    return { ok: true, dose: this.ledger.recordTemp(segments, now) };
                return fail(`Failed to set temp basal: ${errorText(e)}`);
            }
            if (!result.success)
                return fail(`Pump rejected command (${plan.command.kind === 'short' ? `${plan.durationMin} min` : 'full hour'})`);
            this.screen = { ...screen, isTempBasalInProgress: true, tempBasalPercent: plan.percent };
            this.log.info(`Dana: started ${plan.percent}% temp basal for ${plan.durationMin} min (${segments.map((x) => `${x.rate} U/h`).join(', ')})`);
            return { ok: true, dose: this.ledger.recordTemp(segments, now) };
        });
    }
    cancelTempBasal() {
        return this.serial(() => this.doCancelTempBasal());
    }
    bolus(units, options) {
        return this.serial(async () => {
            if (this.bolusState)
                return fail('Pump already busy bolussing');
            const amount = roundToSupportedBolusVolume(units);
            if (amount <= 0)
                return fail(`Bolus of ${units} U is below the smallest supported volume (${BOLUS_INCREMENT} U)`);
            try {
                await this.ensureConnected();
            }
            catch (e) {
                return fail(`No connection: ${errorText(e)}`);
            }
            if (this.screen?.isPumpSuspended)
                return fail('Pump is suspended');
            const startedAt = this.clock.now();
            const pending = {
                id: this.ledger.newId(options.automatic ? 'smb' : 'bolus'),
                requested: amount,
                automatic: options.automatic,
                startedAt,
                expectedEnd: startedAt + amount * secondsPerUnit(this.config.bolusSpeed) * 1000,
                phase: 'starting',
                delivered: 0,
                lastReportedStep: 0,
            };
            // Registered before the command is sent, so a link drop while sending marks it uncertain
            this.bolusState = pending;
            let result;
            try {
                result = await this.send(danaBolusStart({ amount, speed: this.config.bolusSpeed }));
            }
            catch (e) {
                if (this.bolusState === pending)
                    pending.phase = 'uncertain';
                this.log.error(`Dana: no confirmation for bolus start: ${errorText(e)}`);
                return fail(`No confirmation from the pump (${errorText(e)}). Delivery is uncertain and will be reconciled from the pump history.`);
            }
            if (!result.success) {
                if (this.bolusState === pending)
                    this.bolusState = null;
                return fail(transformBolusError(result.rawData[2] ?? 0));
            }
            if (pending.phase === 'starting')
                pending.phase = 'running';
            this.log.info(`Dana: successfully started bolus of ${amount} U`);
            return { ok: true };
        });
    }
    cancelBolus() {
        return this.serial(async () => {
            const b = this.bolusState;
            if (!b)
                return { ok: true };
            try {
                await this.ensureConnected();
                const result = await this.send(danaBolusStop());
                if (!result.success)
                    return fail('Pump rejected the bolus stop');
                b.expectedEnd = Math.min(b.expectedEnd, this.clock.now());
            }
            catch (e) {
                return fail(`Failed to cancel bolus: ${errorText(e)}`);
            }
            // The pump reports the final amount with DELIVERY_COMPLETE; otherwise read its history
            for (let waited = 0; this.bolusState === b && waited < STOP_SETTLE_MS; waited += 50)
                await sleep(50);
            if (this.bolusState === b) {
                b.phase = 'uncertain';
                await this.reconcileUncertainBolus().catch((e) => this.log.warn(`Dana: reconcile after stop failed: ${errorText(e)}`));
            }
            const dose = this.ledger.find(b.id);
            return dose ? { ok: true, dose } : { ok: true };
        });
    }
    suspend() {
        return this.serial(async () => {
            try {
                await this.prepare();
                const screen = this.screen;
                const now = this.clock.now();
                if (screen?.isTempBasalInProgress) {
                    const cancel = await this.send(danaBasalCancelTemporary());
                    if (!cancel.success)
                        return fail('Could not cancel old temp basal');
                    this.ledger.recordTempEnd(now);
                    this.log.info('Dana: successfully canceled old temp basal');
                }
                const result = await this.send(danaBasalSetSuspendOn());
                if (!result.success)
                    return fail('Pump rejected command');
                const dose = this.ledger.recordSuspend(now);
                if (screen)
                    this.screen = { ...screen, isPumpSuspended: true, isTempBasalInProgress: false };
                this.log.info('Dana: insulin delivery suspended!');
                return { ok: true, dose };
            }
            catch (e) {
                return fail(`Failed to suspend delivery: ${errorText(e)}`);
            }
        });
    }
    resume() {
        return this.serial(async () => {
            try {
                await this.ensureConnected();
                const result = await this.send(danaBasalSetSuspendOff());
                if (!result.success)
                    return fail('Pump rejected command');
                const now = this.clock.now();
                const dose = this.ledger.recordResume(now);
                if (this.screen)
                    this.screen = { ...this.screen, isPumpSuspended: false };
                this.log.info('Dana: insulin delivery resumed!');
                return { ok: true, dose };
            }
            catch (e) {
                return fail(`Failed to resume delivery: ${errorText(e)}`);
            }
        });
    }
    history(since) {
        return this.serial(async () => {
            this.bolusRunningAndOnTime(this.clock.now());
            if (this.bolusState?.phase === 'uncertain') {
                try {
                    await this.ensureConnected();
                    await this.reconcileUncertainBolus();
                }
                catch (e) {
                    this.log.warn(`Dana: could not reconcile the uncertain bolus yet: ${errorText(e)}`);
                }
            }
            return this.ledger.since(since);
        });
    }
    // ── Extra API (pairing, time) ───────────────────────────────────────────────────
    /** Called when a Dana RS (v3) shows its two PINs; answer with `providePincode()`. */
    onPincodeRequest(listener) {
        this.pincodeListeners.add(listener);
        return () => this.pincodeListeners.delete(listener);
    }
    /** PIN 1 (12 hex characters) and PIN 2 (8 hex characters) as shown on the Dana RS display. */
    providePincode(pin1, pin2) {
        const parsed = parsePincodes(pin1, pin2);
        if ('error' in parsed)
            return fail(parsed.error);
        const resolve = this.pincodeResolver;
        if (!resolve)
            return fail('No pairing in progress');
        this.pincodeResolver = null;
        resolve(parsed);
        return { ok: true };
    }
    /** Forgets pairing keys, BLE identifier and history cursor of this pump. */
    forgetPairing() {
        return this.serial(async () => {
            this.session.pairingKey = new Uint8Array(0);
            this.session.randomPairingKey = new Uint8Array(0);
            this.session.ble5Keys = new Uint8Array(0);
            await this.store.clear();
        });
    }
    /** `syncPumpTime`: sets the pump clock to the phone's time (and zone on UTC models). */
    syncPumpTime() {
        return this.serial(async () => {
            try {
                await this.ensureConnected();
                return await this.doSyncPumpTime();
            }
            catch (e) {
                return fail(`Failed to sync time: ${errorText(e)}`);
            }
        });
    }
    // ── Connection ──────────────────────────────────────────────────────────────────
    serial(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }
    async loadPersisted() {
        if (this.loaded)
            return;
        const p = await this.store.load();
        this.session.pairingKey = bytesOrEmpty(p.pairingKey);
        this.session.randomPairingKey = bytesOrEmpty(p.randomPairingKey);
        this.session.ble5Keys = bytesOrEmpty(p.ble5Keys);
        this.loaded = true;
    }
    /** `ensureConnected` + `updateInitialState` (InteractiveBluetoothManager). */
    async ensureConnected() {
        if (this.link && this.session.isConnected)
            return this.link;
        await this.loadPersisted();
        const persisted = await this.store.load();
        const { link, bleId } = await openLink({
            ble: this.ble,
            log: this.log,
            session: this.session,
            timeouts: this.timeouts,
            knownBleId: persisted.bleId ?? null,
            onKeysChanged: () => void this.persistKeys().catch((e) => this.log.error(`Dana: could not store pairing keys: ${errorText(e)}`)),
            onNotification: (n) => this.onNotification(n),
            onDisconnect: (conn, error) => this.handleDisconnect(conn, error),
            awaitPincode: () => this.awaitPincode(),
        });
        this.link = link;
        if (bleId !== persisted.bleId)
            await this.store.update({ bleId });
        const mismatch = (this.config.expectedModel === 'dana-i' && this.session.encryptionMode !== EncryptionType.BLE_5) ||
            (this.config.expectedModel === 'dana-rs' && this.session.encryptionMode !== EncryptionType.RSv3);
        if (mismatch) {
            const l = this.link;
            this.dropLink();
            l.peripheral.close(new Error('Wrong pump model'));
            await l.conn.disconnect().catch(() => { });
            throw new Error(`Connected pump is not a ${this.config.expectedModel === 'dana-i' ? 'Dana-i (BLE5)' : 'Dana RS (v3)'}`);
        }
        try {
            this.log.info('Dana: sending keep alive message');
            await this.send(danaGeneralKeepConnection());
        }
        catch (e) {
            this.log.error(`Dana: failed to send keep alive message: ${errorText(e)}`);
        }
        await this.refreshScreen();
        await this.fetchBasalProfile();
        return link;
    }
    /** ensureConnected + a fresh InitialScreenInformation (DanaKit refreshes before every command). */
    async prepare() {
        await this.ensureConnected();
        if (this.clock.now() - this.screenAt > SCREEN_FRESH_MS || !this.screen)
            await this.refreshScreen();
    }
    dropLink() {
        this.link = null;
        this.session.isConnected = false;
        const b = this.bolusState;
        if (b && b.phase !== 'uncertain') {
            // checkBolusDone — DanaKit assumes full delivery here; Buddy reconciles from history instead
            this.log.warn(`Dana: disconnected from pump while ongoing bolus - ${b.delivered}U of ${b.requested}U`);
            b.phase = 'uncertain';
        }
    }
    handleDisconnect(conn, error) {
        if (this.link?.conn !== conn)
            return;
        this.log.info(`Dana: device disconnected${error ? ` (${error.message})` : ''}`);
        this.dropLink();
    }
    async persistKeys() {
        await this.store.update({
            pairingKey: hexOrUndefined(this.session.pairingKey),
            randomPairingKey: hexOrUndefined(this.session.randomPairingKey),
            ble5Keys: hexOrUndefined(this.session.ble5Keys),
        });
    }
    awaitPincode() {
        const p = new Promise((resolve) => {
            this.pincodeResolver = resolve;
        });
        for (const l of this.pincodeListeners)
            l();
        return p;
    }
    send(packet) {
        const link = this.link;
        if (!link)
            return Promise.reject(new Error('No connected device'));
        return link.peripheral.writeMessage(packet, this.timeouts.commandMs);
    }
    // ── Pump data ─────────────────────────────────────────────────────────────────
    async refreshScreen() {
        const r = await this.send(danaGeneralGetInitialScreenInformation());
        if (!r.success || !r.data)
            throw new Error('Failed to fetch Initial screen...');
        this.applyScreen(r.data);
    }
    /** Records basal changes made on the pump itself (temp ended early, suspended/resumed on the pump). */
    applyScreen(s) {
        const now = this.clock.now();
        if (!s.isTempBasalInProgress)
            this.ledger.recordTempEnd(now);
        if (s.isPumpSuspended && !this.ledger.isSuspendedRecorded)
            this.ledger.recordSuspend(now);
        else if (!s.isPumpSuspended && this.ledger.isSuspendedRecorded)
            this.ledger.recordResume(now);
        this.screen = s;
        this.screenAt = now;
        this.lastSync = now;
    }
    async fetchBasalProfile() {
        try {
            const r = await this.send(danaBasalGetRate());
            if (r.success && r.data)
                this.basalProfile = r.data.basalProfile;
            else
                this.log.error('Dana: pump refused to send basal rates back');
        }
        catch (e) {
            this.log.error(`Dana: failed to read basal rates: ${errorText(e)}`);
        }
    }
    async fetchPumpTime() {
        try {
            const r = usingUtc(this.session) ? await this.send(danaGeneralGetPumpTimeUtcWithTimezone()) : await this.send(danaGeneralGetPumpTime());
            if (!r.success || !r.data)
                return null;
            this.pumpClockOffset = r.data.time - this.clock.now();
            return r.data.time;
        }
        catch (e) {
            this.log.error(`Dana: failed to fetch pump time: ${errorText(e)}`);
            return null;
        }
    }
    async doSyncPumpTime() {
        const now = this.clock.now();
        // `round(Double(secondsFromGMT / 3600))` — integer division first, so +5:30 becomes 5
        const offsetInHours = Math.trunc((-new Date(now).getTimezoneOffset() * 60) / 3600);
        const packet = usingUtc(this.session) ? danaGeneralSetPumpTimeUtcWithTimezone({ time: now, zoneOffset: offsetInHours }) : danaGeneralSetPumpTime({ time: now });
        const result = await this.send(packet);
        if (!result.success)
            return fail('Failed to sync pump time: Pump rejected command');
        this.log.info('Dana: pump time synced!');
        return { ok: true };
    }
    /** `shouldSyncTime`: only when the pump's day differs from the phone's day. */
    async maybeSyncTime(pumpTime) {
        if (!this.config.autoTimeSync || pumpTime === null)
            return;
        if (new Date(pumpTime).getDate() === new Date(this.clock.now()).getDate())
            return;
        const r = await this.doSyncPumpTime();
        if (!r.ok)
            this.log.error(`Dana: failed to automatically sync pump time: ${r.error}`);
    }
    /** Reconciles an uncertain bolus, otherwise re-reads pump history when stale (`syncPump`). */
    async backgroundSync() {
        if (this.bolusState?.phase === 'uncertain') {
            await this.reconcileUncertainBolus();
            return;
        }
        if (this.bolusState || this.clock.now() - this.lastHistorySync < HISTORY_STALE_MS)
            return;
        await this.syncHistory(null);
    }
    /**
     * `syncHistory`: SET_HISTORY_UPLOAD_MODE(1) → ALL_HISTORY(from) → SET_HISTORY_UPLOAD_MODE(0).
     * Returns the records, or `null` if the pump did not deliver them.
     */
    async syncHistory(fromOverride) {
        const persisted = await this.store.load();
        const cursor = persisted.historyFrom ?? null;
        if (cursor === null && fromOverride === null) {
            // First sync for this pump: start the cursor now (DanaKit starts at "now" as well)
            const pumpTime = await this.fetchPumpTime();
            await this.store.update({ historyFrom: pumpTime ?? this.clock.now() });
            this.lastHistorySync = this.clock.now();
            await this.maybeSyncTime(pumpTime);
            return [];
        }
        const from = Math.min(cursor ?? Number.POSITIVE_INFINITY, fromOverride ?? Number.POSITIVE_INFINITY);
        // Read before the upload: records written meanwhile are simply read again next time
        const pumpTime = await this.fetchPumpTime();
        const activate = await this.send(danaGeneralSetHistoryUploadMode({ mode: 1 }));
        if (!activate.success)
            return null;
        let items = null;
        try {
            const link = this.link;
            if (!link)
                throw new Error('No connected device');
            const r = await link.peripheral.writeHistory(danaHistoryAll({ from, usingUtc: usingUtc(this.session) }));
            if (r.success && r.data)
                items = r.data;
        }
        finally {
            await this.send(danaGeneralSetHistoryUploadMode({ mode: 0 })).catch((e) => this.log.warn(`Dana: could not leave history mode: ${errorText(e)}`));
        }
        if (!items)
            return null;
        await this.importHistory(items, cursor);
        // Never move the cursor past a bolus that is still being reconciled
        if (!this.bolusState)
            await this.store.update({ historyFrom: pumpTime ?? this.clock.now() + this.pumpClockOffset });
        this.lastHistorySync = this.clock.now();
        await this.maybeSyncTime(pumpTime);
        return items;
    }
    /**
     * Bolus records only (DanaKit's prime/refill/alarm events have no Buddy equivalent). Records
     * inside the run time of one of our boluses belong to it (and settle an uncertain one); every
     * other record at or after the cursor is a bolus the user made directly on the pump.
     */
    async importHistory(items, cursor) {
        const idOf = (i) => historyRecordId(this.session.deviceName, i);
        const records = items.filter((i) => i.code === HistoryCode.RECORD_TYPE_BOLUS && i.value !== undefined);
        const prints = (await this.store.load()).fingerprints ?? [];
        const pending = this.bolusState;
        const attributed = attributeRecords(records, pending ? [...prints, fingerprintOf(pending)] : prints, this.pumpClockOffset, idOf);
        if ([...attributed.keys()].some((id) => id !== pending?.id)) {
            const withRecord = (f) => {
                const r = attributed.get(f.id);
                return r && !f.recordId ? { ...f, recordId: idOf(r) } : f;
            };
            await this.store.modify((cur) => ({ fingerprints: (cur.fingerprints ?? []).map(withRecord) }));
        }
        const pendingRecord = pending ? attributed.get(pending.id) : undefined;
        if (pending?.phase === 'uncertain' && pendingRecord?.value !== undefined) {
            this.log.info(`Dana: uncertain bolus reconciled from pump history: ${pendingRecord.value} U of ${pending.requested} U`);
            this.finalizeBolus(pending, pendingRecord.value, idOf(pendingRecord));
        }
        const own = new Set([...attributed.values()].map(idOf));
        for (const f of (await this.store.load()).fingerprints ?? [])
            if (f.recordId)
                own.add(f.recordId);
        for (const item of records) {
            const id = idOf(item);
            if (own.has(id) || this.seenHistory.has(id))
                continue;
            if (cursor !== null && item.timestamp < cursor)
                continue;
            // While our bolus runs the pump cannot deliver another one; leave unattributed records near it for later
            if (pending && item.timestamp >= pending.startedAt + this.pumpClockOffset - MATCH_SKEW_MS)
                continue;
            this.seenHistory.add(id);
            this.log.info(`Dana: imported pump bolus of ${item.value} U from pump history`);
            this.ledger.push({ kind: 'bolus', id, date: item.timestamp - this.pumpClockOffset, units: Math.round((item.value ?? 0) * 100) / 100 });
        }
    }
    // ── Bolus tracking ────────────────────────────────────────────────────────────
    /** True while a confirmed bolus is within its expected duration; flags overdue ones uncertain. */
    bolusRunningAndOnTime(now) {
        const b = this.bolusState;
        if (!b || b.phase === 'uncertain')
            return false;
        if (now <= b.expectedEnd + COMPLETION_OVERDUE_MS)
            return true;
        this.log.warn('Dana: no DELIVERY_COMPLETE received in time; reconciling the bolus from pump history');
        b.phase = 'uncertain';
        return false;
    }
    async reconcileUncertainBolus() {
        const b = this.bolusState;
        if (!b || b.phase !== 'uncertain')
            return;
        const items = await this.syncHistory(b.startedAt + this.pumpClockOffset - 2 * MATCH_SKEW_MS);
        if (items === null || this.bolusState !== b)
            return;
        if (this.clock.now() > b.expectedEnd + UNCERTAIN_GRACE_MS) {
            // The pump answered but has no record: keep only what it confirmed while the link was up
            this.log.error(`Dana: no pump history record for the uncertain bolus; recording the confirmed ${b.delivered} U`);
            this.finalizeBolus(b, b.delivered);
        }
    }
    finalizeBolus(b, deliveredUnits, recordId) {
        if (this.bolusState !== b)
            return;
        this.bolusState = null;
        if (deliveredUnits > 0)
            this.ledger.push(bolusDose(b, deliveredUnits));
        this.log.info(`Dana: bolus completed - ${deliveredUnits}U of ${b.requested}U`);
        void this.rememberBolus({ ...fingerprintOf(b), end: Math.max(b.startedAt, Math.min(b.expectedEnd, this.clock.now())), ...(recordId ? { recordId } : {}) });
        // notifyBolusDone: refresh the reservoir level
        void this.serial(async () => {
            if (this.link)
                await this.refreshScreen();
        }).catch((e) => this.log.warn(`Dana: post-bolus refresh failed: ${errorText(e)}`));
    }
    /** Persists the fingerprint of a finished bolus so its pump record is never imported as a new bolus. */
    async rememberBolus(f) {
        try {
            const cutoff = this.clock.now() - FINGERPRINT_RETENTION_MS;
            await this.store.modify((cur) => ({ fingerprints: [...(cur.fingerprints ?? []).filter((x) => x.end >= cutoff && x.id !== f.id), f] }));
        }
        catch (e) {
            this.log.error(`Dana: could not store the bolus fingerprint: ${errorText(e)}`);
        }
    }
    onNotification(n) {
        const b = this.bolusState;
        switch (n.kind) {
            case 'deliveryRateDisplay': {
                const p = parseNotifyDeliveryRateDisplay(n.data);
                if (!b || !p.success || !p.data)
                    return;
                b.delivered = p.data.deliveredInsulin;
                const currentStep = Math.floor(p.data.deliveredInsulin);
                if (currentStep > b.lastReportedStep) {
                    b.lastReportedStep = currentStep;
                    void this.serial(() => this.send(danaGeneralKeepConnection())).then((r) => (r.success ? this.log.info('Dana: pump accepted keepalive') : this.log.warn('Dana: pump declined keepalive')), (e) => this.log.error(`Dana: failed to send keepalive: ${errorText(e)}`));
                }
                return;
            }
            case 'deliveryComplete': {
                const p = parseNotifyDeliveryComplete(n.data);
                if (!b || !p.success || !p.data)
                    return;
                this.finalizeBolus(b, p.data.deliveredInsulin);
                return;
            }
            case 'alarm': {
                const p = parseNotifyAlarm(n.data);
                this.log.error(`Dana: pump alarm ${p.data?.alert ?? 'unknown'} (0x${(p.data?.code ?? 0).toString(16)})`);
                if (b && b.phase !== 'uncertain')
                    b.phase = 'uncertain';
                return;
            }
            case 'missedBolus':
                this.log.warn('Dana: missed bolus alarm');
                return;
        }
    }
    // ── Basal bookkeeping ──────────────────────────────────────────────────────────
    async doCancelTempBasal() {
        if (this.bolusState)
            return fail('Rejecting command -> Pump is bolussing...');
        try {
            await this.prepare();
            if (this.screen?.isTempBasalInProgress) {
                const r = await this.send(danaBasalCancelTemporary());
                if (!r.success)
                    return fail('Could not cancel old temp basal');
                this.screen = { ...this.screen, isTempBasalInProgress: false };
            }
            this.ledger.recordTempEnd(this.clock.now());
            this.log.info('Dana: successfully cancelled temp basal');
            return { ok: true };
        }
        catch (e) {
            return fail(`Failed to cancel temp basal: ${errorText(e)}`);
        }
    }
    async verifyTempRunning(percent) {
        try {
            await this.ensureConnected();
            await this.refreshScreen();
            // The screen reports the percentage in one byte; above 255 % any running temp is ours (the old one was cancelled first)
            return !!this.screen?.isTempBasalInProgress && (percent > 255 || this.screen.tempBasalPercent === percent);
        }
        catch {
            return false;
        }
    }
    buildState(now) {
        const s = this.screen;
        const activeTemp = this.ledger.activeTemp(now);
        let tempBasal = null;
        if (s?.isTempBasalInProgress) {
            // A temp set on the pump itself has no known start/duration
            tempBasal = activeTemp ?? { rate: percentToRate(s.tempBasalPercent, scheduledBasalRate(this.basalProfile, now)), startedAt: this.lastSync, durationMin: 0 };
        }
        return {
            reservoirUnits: s && s.reservoirRemainingUnits >= 0 ? s.reservoirRemainingUnits : null,
            batteryPercent: s && s.batteryRemaining >= 0 ? s.batteryRemaining : null,
            suspended: s?.isPumpSuspended ?? false,
            tempBasal,
            bolusing: this.bolusState !== null,
            bolusIncrement: BOLUS_INCREMENT,
            basalIncrement: BASAL_INCREMENT,
            lastSync: this.lastSync,
        };
    }
}
