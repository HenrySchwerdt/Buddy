export interface GlycemicMetrics {
  readonly mean: number;
  readonly sd: number;
  readonly cv: number;
  readonly gmi: number;
  /** % time in 70–180 */
  readonly tir: number;
  /** % time in 70–140 */
  readonly titr: number;
  readonly tbr70: number;
  readonly tbr54: number;
  readonly tar180: number;
  readonly tar250: number;
  readonly lbgi: number;
  readonly hbgi: number;
  readonly min: number;
  readonly max: number;
  /** Episodes ≥15 min below 54 mg/dL */
  readonly severeHypoEvents: number;
  readonly totalInsulin: number;
  readonly autoBolusInsulin: number;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Kovatchev risk function. */
const riskF = (bg: number) => 1.509 * (Math.pow(Math.log(Math.max(bg, 20)), 1.084) - 5.381);

/** Consensus CGM metrics (Battelino 2019) on evenly spaced glucose values (mg/dL). */
export function computeMetrics(values: readonly number[], stepMinutes: number, insulin = { total: 0, auto: 0 }): GlycemicMetrics {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n));
  const count = (f: (v: number) => boolean) => values.filter(f).length;
  let lbgi = 0;
  let hbgi = 0;
  for (const v of values) {
    const f = riskF(v);
    const r = 10 * f * f;
    if (f < 0) lbgi += r;
    else hbgi += r;
  }
  let events = 0;
  let run = 0;
  for (const v of values) {
    run = v < 54 ? run + stepMinutes : 0;
    if (run === 15 || (run > 0 && run < 15 && stepMinutes >= 15)) events++;
  }
  return {
    mean: r1(mean),
    sd: r1(sd),
    cv: pct(sd, mean),
    gmi: r2(3.31 + 0.02392 * mean),
    tir: pct(count((v) => v >= 70 && v <= 180), n),
    titr: pct(count((v) => v >= 70 && v <= 140), n),
    tbr70: pct(count((v) => v < 70), n),
    tbr54: pct(count((v) => v < 54), n),
    tar180: pct(count((v) => v > 180), n),
    tar250: pct(count((v) => v > 250), n),
    lbgi: r2(lbgi / Math.max(1, n)),
    hbgi: r2(hbgi / Math.max(1, n)),
    min: Math.round(Math.min(...values)),
    max: Math.round(Math.max(...values)),
    severeHypoEvents: events,
    totalInsulin: r2(insulin.total),
    autoBolusInsulin: r2(insulin.auto),
  };
}
