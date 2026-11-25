// TypeScript port of trio-oref/lib/basal-set-temp.js (nightscout/Trio dev, MIT License,
// © the OpenAPS / oref0 and Trio contributors; see ../LICENSE-oref). Logic unchanged.
import { orefConsole as console } from '../logger';
import round_basal from './round-basal';
function reason(rT, msg) {
    rT.reason = (rT.reason ? rT.reason + '. ' : '') + msg;
    console.error(msg);
}
const isMissing = (x) => x === null || x === undefined || Number.isNaN(x);
const tempBasalFunctions = {
    getMaxSafeBasal(profile) {
        const max_daily_safety_multiplier = isMissing(profile.max_daily_safety_multiplier) ? 3 : profile.max_daily_safety_multiplier;
        const current_basal_safety_multiplier = isMissing(profile.current_basal_safety_multiplier) ? 4 : profile.current_basal_safety_multiplier;
        return Math.min(profile.max_basal, max_daily_safety_multiplier * profile.max_daily_basal, current_basal_safety_multiplier * profile.current_basal);
    },
    setTempBasal(rate, duration, profile, rT, currenttemp) {
        const maxSafeBasal = tempBasalFunctions.getMaxSafeBasal(profile);
        if (rate < 0) {
            rate = 0;
        }
        else if (rate > maxSafeBasal) {
            rate = maxSafeBasal;
        }
        const suggestedRate = round_basal(rate, profile);
        if (typeof currenttemp !== 'undefined' &&
            typeof currenttemp.duration !== 'undefined' &&
            typeof currenttemp.rate !== 'undefined' &&
            currenttemp.duration > duration - 10 &&
            currenttemp.duration <= 120 &&
            suggestedRate <= currenttemp.rate * 1.2 &&
            suggestedRate >= currenttemp.rate * 0.8 &&
            duration > 0) {
            rT.reason += ' ' + currenttemp.duration + 'm left and ' + currenttemp.rate + ' ~ req ' + suggestedRate + 'U/hr: no temp required';
            return rT;
        }
        if (suggestedRate === profile.current_basal) {
            if (profile.skip_neutral_temps === true) {
                if (typeof currenttemp !== 'undefined' && typeof currenttemp.duration !== 'undefined' && currenttemp.duration > 0) {
                    reason(rT, 'Suggested rate is same as profile rate, a temp basal is active, canceling current temp');
                    rT.duration = 0;
                    rT.rate = 0;
                    return rT;
                }
                reason(rT, 'Suggested rate is same as profile rate, no temp basal is active, doing nothing');
                return rT;
            }
            reason(rT, 'Setting neutral temp basal of ' + profile.current_basal + 'U/hr');
            rT.duration = duration;
            rT.rate = suggestedRate;
            return rT;
        }
        rT.duration = duration;
        rT.rate = suggestedRate;
        return rT;
    },
};
export default tempBasalFunctions;
