// TypeScript port of trio-oref/lib/round-basal.js (nightscout/Trio dev, MIT License,
// © the OpenAPS / oref0 and Trio contributors; see ../LICENSE-oref). Logic unchanged.
/**
 * x23 and x54 pumps change basal increment depending on how much basal is being delivered:
 * 0.025u for 0.025 < x < 0.975, 0.05u for 1 < x < 9.95, 0.1u for 10 < x.
 * To round numbers nicely for the pump, use a scale factor of (1 / increment).
 */
export default function round_basal(basal, profile) {
    let lowest_rate_scale = 20;
    if (typeof profile !== 'undefined' && typeof profile.model === 'string') {
        if (profile.model.endsWith('54') || profile.model.endsWith('23'))
            lowest_rate_scale = 40;
    }
    if (basal < 1)
        return Math.round(basal * lowest_rate_scale) / lowest_rate_scale;
    if (basal < 10)
        return Math.round(basal * 20) / 20;
    return Math.round(basal * 10) / 10;
}
