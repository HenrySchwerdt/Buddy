import { effectiveSettings } from './adjustments';
const r2 = (x) => Math.round(x * 100) / 100;
/** Classic bolus calculator: carbs + correction to target − IOB + 15-min trend. */
export function recommendBolus(i) {
    const { profile, now } = i;
    const eff = effectiveSettings(profile, now, i.override, i.tempTarget);
    const cr = Math.round(eff.carbRatio * 10) / 10;
    const isf = Math.round(eff.isf);
    const target = eff.target;
    const mid = (target.low + target.high) / 2;
    const carbUnits = i.carbs > 0 ? i.carbs / cr : 0;
    const correctionUnits = i.glucose == null ? 0 : (i.glucose - mid) / isf;
    const trendUnits = i.glucose == null ? 0 : (i.delta * 3) / isf;
    const raw = (carbUnits + correctionUnits + trendUnits - i.iob) * i.fraction;
    const explanation = [
        `${i.carbs} g ÷ ${cr} g/U = ${r2(carbUnits)} U`,
        i.glucose == null ? 'No glucose: no correction' : `(${Math.round(i.glucose)} − ${Math.round(mid)}) ÷ ${isf} = ${r2(correctionUnits)} U`,
        `Trend 15 min: ${r2(trendUnits)} U`,
        `IOB: −${r2(i.iob)} U`,
        `× ${Math.round(i.fraction * 100)} %`,
    ];
    return { carbUnits: r2(carbUnits), correctionUnits: r2(correctionUnits), iobUnits: r2(i.iob), trendUnits: r2(trendUnits), total: Math.max(0, r2(raw)), explanation };
}
