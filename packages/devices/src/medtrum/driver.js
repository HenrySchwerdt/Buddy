import { basalScheduleToBytes, validateBasalSchedule } from './basal-schedule';
import { floorToInsulinStep } from './bytes';
import { AlarmSettings, ClearAlarmType, PatchState, basalType, patchState, patchStateName } from './enums';
import { describeWriteError, isUncertain } from './link';
import { ActivatePacket, CancelBolusPacket, CancelTempBasalPacket, ClearAlertPacket, PrimePacket, ResumePumpPacket, SetBasalProfilePacket, SetBolusPacket, SetPatchPacket, SetTempBasalPacket, SetTimePacket, SetTimeZonePacket, StopPatchPacket, SuspendPumpPacket, } from './packets';
import { leUint } from './bytes';
import { MAX_BOLUS_UNITS } from './state-syncer';
import { MedtrumError, MedtrumNanoCore, LOOP_SYNC_FRESHNESS_MS, expectedBolusEndMs } from './driver-core';
/** Longest temp basal accepted (the packet allows 65535 min; LoopKit uses at most 24 h). */
export const MAX_TEMP_BASAL_MIN = 24 * 60;
export const MEDTRUM_NANO_META = {
    id: 'medtrum-nano',
    name: 'Medtrum Nano',
    manufacturer: 'Medtrum',
    description: 'Medtrum TouchCare Nano patch pump over Bluetooth (port of MedtrumKit). Experimental: verify on hardware, never worn, first.',
    transport: 'ble',
    maturity: 'experimental',
    requiresHardwareCheck: true,
};
/** `ExpiryMode.timer`: default = 1 (12 h reminder, expiry after 3 days), extended = 0 */
export const expirationTimer = (mode) => (mode === 'default' ? 1 : 0);
const fail = (error) => ({ ok: false, error });
const errMsg = (e) => (e instanceof Error ? e.message : String(e));
export class MedtrumNanoDriver extends MedtrumNanoCore {
    meta = MEDTRUM_NANO_META;
    constructor(settings, ctx, options = {}) {
        super(settings, ctx, options);
    }
    get alarmSetting() {
        const name = this.settings.alarmSetting;
        return name in AlarmSettings ? AlarmSettings[name] : AlarmSettings.BeepOnly;
    }
    get expiryMode() {
        return this.settings.expiryMode === 'extended' ? 'extended' : 'default';
    }
    /** Runs a serialized command; anything thrown becomes `{ ok: false }`. */
    command(name, fn) {
        return this.serialize(async () => {
            try {
                return await fn();
            }
            catch (e) {
                this.log.error(`Medtrum ${name}: ${errMsg(e)}`);
                return fail(`${name}: ${errMsg(e)}`);
            }
        });
    }
    writeFailure(what, e) {
        const msg = `${what}: ${describeWriteError(e)}`;
        this.log.error(`Medtrum: ${msg}`);
        return fail(msg);
    }
    // ── PumpDriver ─────────────────────────────────────────────────────────────
    connect() {
        return this.serialize(() => this.ensureConnected());
    }
    disconnect() {
        return this.serialize(async () => {
            this.dropConnection();
        });
    }
    /** `ensureCurrentPumpData`: syncs when the data is stale or a resync is owed, otherwise answers from the last status. */
    async status() {
        try {
            await this.serialize(async () => {
                await this.load();
                const s = this.session;
                if (patchState.isSetup(s.pumpState))
                    return;
                const stale = this.now() - s.lastSync > LOOP_SYNC_FRESHNESS_MS;
                const p = this.ledger.pendingBolus;
                // a resync is owed for an unresolved bolus / temp basal, or a bolus that should be over
                const owed = ((p !== null || this.ledger.pendingTempBasal !== null) && !this.isConnected) ||
                    (p !== null && this.now() >= expectedBolusEndMs(p.requested, p.sentAt));
                if (!stale && !owed)
                    return;
                if (!this.isConnected) {
                    await this.ensureConnected(); // the connect itself runs a full sync
                }
                else {
                    await this.fullSync();
                }
            });
        }
        catch (e) {
            this.log.warn(`Medtrum status: using last known state (${errMsg(e)})`);
        }
        try {
            await this.load();
            return this.snapshotState();
        }
        catch {
            return {
                reservoirUnits: null,
                batteryPercent: null,
                suspended: true,
                tempBasal: null,
                bolusing: false,
                bolusIncrement: 0.05,
                basalIncrement: 0.05,
                lastSync: 0,
            };
        }
    }
    async history(since) {
        try {
            await this.load();
            return this.ledger.history(since, this.now());
        }
        catch (e) {
            this.log.error(`Medtrum history: ${errMsg(e)}`);
            return [];
        }
    }
    setTempBasal(rate, durationMin) {
        return this.command('setTempBasal', async () => {
            await this.load();
            if (!Number.isFinite(rate) || rate < 0 || rate > this.maxBasalRate)
                return fail(`Temp basal rate ${rate} U/h outside 0–${this.maxBasalRate}`);
            const minutes = Math.trunc(durationMin);
            if (!Number.isFinite(durationMin) || minutes < 1 || minutes > MAX_TEMP_BASAL_MIN)
                return fail(`Temp basal duration ${durationMin} min outside 1–${MAX_TEMP_BASAL_MIN}`);
            const enacted = floorToInsulinStep(rate);
            if (this.ledger.pendingBolus)
                return fail('Pump is bolusing');
            await this.ensureConnectedAndActive();
            if (this.session.basalState === 'tempBasal' || this.ledger.basal.kind === 'temp') {
                // Need to cancel temp basal first before setting temp basal
                const cancel = await this.send(new CancelTempBasalPacket());
                if (!cancel.ok)
                    return this.writeFailure('Failed to cancel temp basal', cancel.error);
                this.ledger.endTempBasal(this.now());
                this.update({ basalState: 'active', lastSync: this.now() });
                await this.persist();
            }
            this.ledger.setPendingTempBasal({ rate: enacted, durationMin: minutes, sentAt: this.now() });
            await this.persist();
            this.tempCommandInFlight = true;
            let r;
            try {
                r = await this.send(new SetTempBasalPacket(enacted, minutes));
            }
            finally {
                this.tempCommandInFlight = false;
            }
            if (!r.ok) {
                // the cancel already succeeded, but new TBR failed - the patch is running the scheduled basal now
                if (!isUncertain(r.error))
                    this.ledger.setPendingTempBasal(null);
                await this.persist();
                return this.writeFailure(isUncertain(r.error) ? 'Temp basal outcome unknown (will resync)' : 'Failed to set temp basal', r.error);
            }
            const at = this.now();
            if (!basalType.isTempBasal(r.data.basalType) || Math.abs(r.data.basalValue - enacted) > 0.001) {
                // The pump answered, but reports a different basal than requested: believe the pump.
                this.ledger.setPendingTempBasal(null);
                this.applyBasalEcho(r.data.basalType, r.data.basalValue, minutes, at);
                await this.persist();
                return fail(`Pump confirmed basal type ${r.data.basalType} at ${r.data.basalValue} U/h instead of a ${enacted} U/h temp basal`);
            }
            this.ledger.startTempBasal(r.data.basalValue, minutes, at);
            this.update({ basalState: 'tempBasal', lastSync: at });
            await this.persist();
            this.log.info(`Medtrum: Set temp basal ${enacted} U/h for ${minutes} min`);
            return { ok: true };
        });
    }
    /** Records what a basal command echo says is running. */
    applyBasalEcho(type, value, durationMin, at) {
        if (basalType.isTempBasal(type)) {
            this.ledger.startTempBasal(value, durationMin, at);
            this.update({ basalState: 'tempBasal', lastSync: at });
        }
        else if (basalType.isSuspendedByPump(type)) {
            this.ledger.suspend(at);
            this.update({ basalState: 'suspended', lastSync: at });
        }
        else {
            this.ledger.endTempBasal(at);
            this.update({ basalState: 'active', lastSync: at });
        }
    }
    cancelTempBasal() {
        return this.command('cancelTempBasal', async () => {
            await this.load();
            // Never blocked by a pending bolus: cancelling only ever reduces insulin.
            const now = this.now();
            const running = this.session.basalState === 'tempBasal' || this.ledger.tempBasalActiveAt(now) !== null || this.ledger.pendingTempBasal !== null;
            if (!running) {
                // Need to cancel temp basal, but is already cancelled
                this.ledger.endTempBasal(now);
                await this.persist();
                return { ok: true };
            }
            await this.ensureConnectedAndActive();
            const r = await this.send(new CancelTempBasalPacket());
            if (!r.ok)
                return this.writeFailure('Failed to cancel temp basal', r.error);
            const at = this.now();
            this.ledger.setPendingTempBasal(null);
            if (basalType.isTempBasal(r.data.basalType)) {
                await this.persist();
                return fail('Pump still reports a temp basal after cancelling');
            }
            this.applyBasalEcho(r.data.basalType, r.data.basalValue, 0, at);
            await this.persist();
            this.log.info('Medtrum: Cancelled temp basal!');
            return { ok: true };
        });
    }
    bolus(units, options) {
        return this.command('bolus', async () => {
            await this.load();
            if (!Number.isFinite(units) || units <= 0)
                return fail(`Invalid bolus amount ${units}`);
            const amount = floorToInsulinStep(units);
            if (amount < 0.05)
                return fail(`Bolus ${units} U is below the 0.05 U increment`);
            if (amount > MAX_BOLUS_UNITS)
                return fail(`Bolus ${units} U exceeds the ${MAX_BOLUS_UNITS} U maximum`);
            if (this.ledger.pendingBolus)
                return fail('Pump is in bolus state');
            if (this.session.basalState === 'suspended')
                return fail('Pump is suspended');
            await this.ensureConnectedAndActive();
            if (this.ledger.pendingBolus)
                return fail('Pump is in bolus state');
            if (!patchState.isDelivering(this.session.pumpState))
                return fail(`Patch is not delivering (${patchStateName(this.session.pumpState)})`);
            // Recorded (and persisted) before sending, so a crash or lost answer leaves a trace to resolve.
            this.ledger.bolusSent(amount, options.automatic, this.now());
            this.resetBolusIdle();
            await this.persist();
            this.bolusCommandInFlight = true;
            let r;
            try {
                r = await this.send(new SetBolusPacket(amount));
            }
            finally {
                this.bolusCommandInFlight = false;
            }
            if (!r.ok) {
                if (!isUncertain(r.error)) {
                    this.ledger.bolusRejected();
                    await this.persist();
                    return this.writeFailure('Failed to start bolus', r.error);
                }
                // The pump may be delivering it: keep it pending; the next sync settles what was delivered.
                await this.persist();
                return this.writeFailure('Bolus outcome unknown, delivery will be reconciled on the next sync', r.error);
            }
            this.ledger.bolusConfirmed();
            this.update({ lastSync: this.now() });
            await this.persist();
            this.log.info(`Medtrum: Enact bolus - ${amount}U`);
            return { ok: true };
        });
    }
    cancelBolus() {
        return this.command('cancelBolus', async () => {
            await this.load();
            if (!this.ledger.pendingBolus)
                return { ok: true };
            await this.ensureConnectedAndActive();
            if (!this.ledger.pendingBolus)
                return { ok: true }; // finished while connecting
            const r = await this.send(new CancelBolusPacket());
            if (!r.ok)
                return this.writeFailure('Failed to cancel bolus', r.error);
            this.log.info('Medtrum: Bolus cancelled!');
            // DEVIATION: Swift records the last progress it saw. We first ask the patch for its final count.
            await this.fullSync();
            // No final count from the patch: record the requested amount, correctable by a later status.
            const dose = this.ledger.pendingBolus ? this.ledger.finalizeBolusUncertain() : null;
            if (dose && (dose.kind === 'bolus' || dose.kind === 'smb'))
                this.log.warn(`Medtrum: cancelled bolus without a final count, recorded ${dose.units} U until the patch reports it`);
            this.update({ lastSync: this.now() });
            await this.persist();
            return dose ? { ok: true, dose } : { ok: true };
        });
    }
    suspend() {
        return this.command('suspend', async () => {
            await this.ensureConnectedAndActive();
            const r = await this.send(new SuspendPumpPacket(this.opts.suspendMinutes));
            if (!r.ok)
                return this.writeFailure('Failed to suspend delivery', r.error);
            const start = this.now();
            this.ledger.setPendingTempBasal(null);
            this.ledger.suspend(start);
            this.update({ basalState: 'suspended', lastSync: start });
            await this.persist();
            this.log.info(`Medtrum: Delivery suspended for ${this.opts.suspendMinutes} min!`);
            return { ok: true };
        });
    }
    resume() {
        return this.command('resume', async () => {
            await this.ensureConnectedAndActive();
            const r = await this.send(new ResumePumpPacket());
            if (!r.ok)
                return this.writeFailure('Failed to resume delivery', r.error);
            const at = this.now();
            this.ledger.resume(at);
            this.update({ basalState: 'active', lastSync: at });
            await this.persist();
            this.log.info('Medtrum: Resumed delivery!');
            return { ok: true };
        });
    }
    // ── Patch lifecycle (exported as functions from ./activation) ──────────────
    /** Current patch status from the last sync (no BLE traffic). */
    async patchStatus() {
        await this.load();
        const s = this.session;
        return {
            connected: this.isConnected,
            patchState: s.pumpState,
            patchStateName: patchStateName(s.pumpState),
            phase: patchState.phase(s.pumpState),
            primeProgress: s.primeProgress,
            reservoirUnits: s.reservoir,
            batteryVolts: s.battery,
            patchId: s.patchId,
            patchActivatedAt: s.patchActivatedAt,
            sessionActive: !s.patchSessionEnded,
            swVersion: s.swVersion,
            model: this.model,
            pumpTime: s.pumpTime,
            lastSync: s.lastSync,
        };
    }
    /** Connects (if needed) and runs a full status sync, also during setup. */
    refreshPatch() {
        return this.command('refreshPatch', async () => {
            if (!this.isConnected) {
                await this.ensureConnected();
                return { ok: true };
            }
            return (await this.fullSync()) ? { ok: true } : fail('Failed to synchronize');
        });
    }
    /** `primePatch`: the patch must be filled (with water for bench tests). */
    prime() {
        return this.command('prime', async () => {
            await this.load();
            this.ensureSessionToken();
            await this.persist();
            await this.ensureConnected();
            const st = this.session.pumpState;
            if (patchState.isTerminated(st))
                return fail(`Cannot prime, patch session is over: ${patchStateName(st)}`);
            if (!patchState.isBeforePriming(st)) {
                this.log.info('Medtrum: Patch is already priming or primed!');
                return { ok: true };
            }
            if (st !== PatchState.filled)
                return fail(`Patch is not filled yet, refusing to prime. State: ${patchStateName(st)}`);
            const r = await this.send(new PrimePacket());
            if (!r.ok)
                return this.writeFailure('Failed to start priming pump', r.error);
            this.log.info('Medtrum: Priming has started!');
            await this.fullSync();
            return { ok: true };
        });
    }
    /** `activatePatch`: programs time, limits and the basal schedule (U/h) and starts delivery. */
    activate(basalSchedule) {
        return this.command('activate', async () => {
            await this.load();
            const problems = validateBasalSchedule(basalSchedule, this.maxBasalRate);
            if (problems.length)
                return fail(problems.join('; '));
            await this.ensureConnected();
            const st = this.session.pumpState;
            if (patchState.isTerminated(st))
                return fail(`Cannot activate, patch session is over: ${patchStateName(st)}`);
            if (patchState.isRunning(st)) {
                // The patch activated, but its answer was lost: the session it starts is not started yet
                if (this.session.patchSessionEnded) {
                    this.log.warn('Medtrum: Patch already activated, but its session was not started - starting it');
                    const start = this.now();
                    const synced = this.session.patchActivatedAt;
                    const deactivatedAt = this.session.previousPatch?.deactivatedAt;
                    const activatedAt = synced !== null && deactivatedAt !== undefined && synced > deactivatedAt && synced <= start ? synced : start;
                    this.startPatchSession(null, start, activatedAt, patchState.isDelivering(st));
                    this.update({ basalSchedule });
                    await this.persist();
                }
                return { ok: true };
            }
            if (!patchState.hasCompletedPriming(st))
                return fail(`Patch is not primed yet (${patchStateName(st)})`);
            await this.syncTime();
            const packet = new ActivatePacket({
                expirationTimer: expirationTimer(this.expiryMode),
                alarmSetting: this.alarmSetting,
                hourlyMaxInsulin: this.settings.maxHourlyInsulin,
                dailyMaxInsulin: this.settings.maxDailyInsulin,
                currentTDD: 0,
                basalProfile: basalScheduleToBytes(basalSchedule),
            });
            const r = await this.send(packet);
            if (!r.ok)
                return this.writeFailure('Failed to activate pump', r.error);
            const start = this.now();
            this.startPatchSession(leUint(r.data.patchId, 0, 4), start, start, true);
            this.update({ basalSchedule });
            await this.persist();
            // DEVIATION: Swift waits for the next notification; we read the new state right away.
            await this.fullSync();
            this.log.info('Medtrum: Patch activated!');
            return { ok: true };
        });
    }
    /** `deactivatePatch`: stops the patch for good and forgets its session. */
    deactivate() {
        return this.command('deactivate', async () => {
            await this.load();
            // The sync that runs as part of connecting can find that the base has reset, and end the session
            const hadActivePatch = !patchState.isSetup(this.session.pumpState);
            try {
                await this.ensureConnected();
            }
            catch (e) {
                if (hadActivePatch && patchState.isSetup(this.session.pumpState))
                    return { ok: true };
                throw e;
            }
            if (hadActivePatch && patchState.isSetup(this.session.pumpState)) {
                this.log.info('Medtrum: Patch session already ended while connecting, nothing left to deactivate');
                return { ok: true };
            }
            this.isDeactivatingPatch = true;
            try {
                const r = await this.send(new StopPatchPacket());
                if (!r.ok)
                    return this.writeFailure('Failed to deactivate pump', r.error);
                // Connected: the connect synced the patch's status, and its notifications have kept it current since
                this.endPatchSession(this.now(), true);
                await this.persist();
                this.log.info('Medtrum: Patch deactivated');
            }
            finally {
                this.isDeactivatingPatch = false;
            }
            this.dropConnection();
            return { ok: true };
        });
    }
    /** `forceDeactivatePatch`: ends the session locally (patch lost / unreachable). */
    forceDeactivate() {
        return this.command('forceDeactivate', async () => {
            await this.load();
            this.endPatchSession(this.now(), false);
            await this.persist();
            this.dropConnection();
            return { ok: true };
        });
    }
    /** `syncBasalRateSchedule` */
    setBasalSchedule(schedule) {
        return this.command('setBasalSchedule', async () => {
            await this.load();
            const problems = validateBasalSchedule(schedule, this.maxBasalRate);
            if (problems.length)
                return fail(problems.join('; '));
            await this.ensureConnectedAndActive();
            const r = await this.send(new SetBasalProfilePacket(basalScheduleToBytes(schedule)));
            if (!r.ok)
                return this.writeFailure('Failed to sync basal schedule', r.error);
            this.update({ basalSchedule: schedule, lastSync: this.now() });
            await this.persist();
            return { ok: true };
        });
    }
    /** `updatePatchSettings`: alarm setting, hourly/daily max and expiry from the plugin settings. */
    updatePatchSettings() {
        return this.command('updatePatchSettings', async () => {
            await this.ensureConnectedAndActive();
            const r = await this.send(new SetPatchPacket({
                alarmSettings: this.alarmSetting,
                hourlyMaxInsulin: this.settings.maxHourlyInsulin,
                dailyMaxInsulin: this.settings.maxDailyInsulin,
                expirationTimer: expirationTimer(this.expiryMode),
            }));
            if (!r.ok)
                return this.writeFailure('Failed to update settings', r.error);
            return { ok: true };
        });
    }
    /** `clearAlert`: clears an hourly/daily max suspension and resumes the patch. */
    clearAlert(type) {
        return this.command('clearAlert', async () => {
            await this.ensureConnectedAndActive();
            const c = await this.send(new ClearAlertPacket(type === 'hourlyMax' ? ClearAlarmType.hourlyMax : ClearAlarmType.daily));
            if (!c.ok)
                return this.writeFailure('Failed to clear alert', c.error);
            const r = await this.send(new ResumePumpPacket());
            if (!r.ok)
                return this.writeFailure('Failed to resume patch', r.error);
            await this.fullSync();
            return { ok: true };
        });
    }
    /** `StateSyncer.syncTime`: SetTime, SetTimeZone, then reads the patch clock back. Failures are logged. */
    async syncTime() {
        const t = await this.send(new SetTimePacket(this.now()));
        if (!t.ok) {
            this.log.error(`Medtrum: Failed to sync time: ${describeWriteError(t.error)}`);
            return;
        }
        const now = this.now();
        const tz = await this.send(new SetTimeZonePacket(now, this.opts.utcOffsetSeconds(now)));
        if (!tz.ok) {
            this.log.error(`Medtrum: Failed to sync timezone: ${describeWriteError(tz.error)}`);
            return;
        }
        await this.fetchPatchTime();
    }
    /** Re-programs the patch clock (time zone change). */
    syncPatchTime() {
        return this.command('syncPatchTime', async () => {
            await this.ensureConnectedAndActive();
            await this.syncTime();
            await this.persist();
            return { ok: true };
        });
    }
}
export { MedtrumError };
