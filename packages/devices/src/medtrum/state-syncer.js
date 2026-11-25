import { leUint } from './bytes';
import { simpleDecrypt } from './crypto';
import { PatchState, patchState } from './enums';
/**
 * An activated patch never goes back to a setup state on its own: when it does, the base has
 * rebooted and came back as a blank patch - with a new patch id, its age and sequence restarted,
 * and no delivery.
 */
export function baseResetCheck(syncResponse, state) {
    // No session: the old patch, stopped, is still reported until the new one is set up - that setup is no reset
    if (patchState.isSetup(state.pumpState) ||
        !patchState.isSetup(syncResponse.state) ||
        (state.patchSessionEnded && patchState.isTerminated(state.pumpState))) {
        return 'noReset';
    }
    if (syncResponse.state !== PatchState.none) {
        return 'reset';
    }
    // `.none` is also what an unknown state byte parses to
    if (!syncResponse.storage || state.patchId === null) {
        return 'unconfirmed';
    }
    return syncResponse.storage.patchId !== state.patchId ? 'reset' : 'unconfirmed';
}
/**
 * The base counts the patch age from its boot, which is when delivery stopped - unless we have
 * heard from the activated patch after that
 */
export function deliveryStoppedAt(syncResponse, state, receivedAt) {
    if (syncResponse.patchAge === undefined) {
        return receivedAt;
    }
    const bootedAt = receivedAt - syncResponse.patchAge * 1000;
    return Math.min(Math.max(bootedAt, state.lastSync), receivedAt);
}
/** `MedtrumPumpState.model`: decoded from the serial number (stored big-endian, e.g. fromHex("AA76F9D9")). */
export function modelFromSerial(pumpSN) {
    if (pumpSN.length !== 4)
        return 'INVALID';
    const type = leUint(simpleDecrypt(pumpSN.slice().reverse()), 0, 4);
    const inRange = (lo) => type >= lo && type < lo + 999_999;
    if (inRange(126_000_000))
        return 'MD0201';
    if (inRange(127_000_000))
        return 'MD5201';
    if (inRange(128_000_000))
        return 'MD8201';
    if (inRange(130_000_000))
        return 'MD0202';
    if (inRange(131_000_000))
        return 'MD5202';
    if (inRange(148_000_000))
        return 'MD8301';
    return 'INVALID';
}
/** 300 U patches (MD8301) allow 0–30 U/h, the 200 U ones 0–25 U/h (`supportedBasalRates`). */
export const maxBasalRateForModel = (model) => (model === 'MD8301' ? 30 : 25);
/** `pumpReservoirCapacity` */
export const reservoirCapacityForModel = (model) => (model === 'MD8301' ? 300 : 200);
/** `onboardingSupportedBolusVolumes`: 0.05 ... 30 U */
export const MAX_BOLUS_UNITS = 30;
