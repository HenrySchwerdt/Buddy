/**
 * Hovorka et al. (2004) glucose–insulin model with parameters from Wilinska et al. (2010).
 * Units: glucose masses in mmol, insulin in mU, time in minutes.
 * This is a research model for comparing algorithms, not a prediction of any real person.
 */
export interface HovorkaParams {
  readonly BW: number; // kg
  readonly EGP0: number; // mmol/kg/min
  readonly F01: number; // mmol/kg/min
  readonly k12: number;
  readonly ka1: number;
  readonly ka2: number;
  readonly ka3: number;
  readonly SIT: number; // /min per mU/L
  readonly SID: number;
  readonly SIE: number;
  readonly ke: number;
  readonly VI: number; // L/kg
  readonly VG: number; // L/kg
  readonly tmaxI: number;
  readonly tmaxG: number;
  readonly AG: number;
}

export const BASE_PARAMS: HovorkaParams = {
  BW: 70,
  EGP0: 0.0161,
  F01: 0.0097,
  k12: 0.066,
  ka1: 0.006,
  ka2: 0.06,
  ka3: 0.03,
  SIT: 51.2e-4,
  SID: 8.2e-4,
  SIE: 520e-4,
  ke: 0.138,
  VI: 0.12,
  VG: 0.16,
  tmaxI: 55,
  tmaxG: 40,
  AG: 0.8,
};

export interface HovorkaState {
  readonly D1: number;
  readonly D2: number;
  readonly S1: number;
  readonly S2: number;
  readonly I: number;
  readonly x1: number;
  readonly x2: number;
  readonly x3: number;
  readonly Q1: number;
  readonly Q2: number;
}

export const MGDL_PER_MMOL = 18.0182;
export const MMOL_PER_GRAM_GLUCOSE = 1000 / 180.16;

export const glucoseMmol = (p: HovorkaParams, s: HovorkaState) => s.Q1 / (p.VG * p.BW);
export const glucoseMgdl = (p: HovorkaParams, s: HovorkaState) => glucoseMmol(p, s) * MGDL_PER_MMOL;

function derivatives(p: HovorkaParams, s: HovorkaState, insulinMuPerMin: number): HovorkaState {
  const G = glucoseMmol(p, s);
  const UG = s.D2 / p.tmaxG;
  const UI = s.S2 / p.tmaxI;
  const F01c = G >= 4.5 ? p.F01 * p.BW : (p.F01 * p.BW * G) / 4.5;
  const FR = G >= 9 ? 0.003 * (G - 9) * p.VG * p.BW : 0;
  const EGP = Math.max(0, p.EGP0 * p.BW * (1 - s.x3));
  return {
    D1: -s.D1 / p.tmaxG,
    D2: s.D1 / p.tmaxG - s.D2 / p.tmaxG,
    S1: insulinMuPerMin - s.S1 / p.tmaxI,
    S2: s.S1 / p.tmaxI - s.S2 / p.tmaxI,
    I: UI / (p.VI * p.BW) - p.ke * s.I,
    x1: -p.ka1 * s.x1 + p.ka1 * p.SIT * s.I,
    x2: -p.ka2 * s.x2 + p.ka2 * p.SID * s.I,
    x3: -p.ka3 * s.x3 + p.ka3 * p.SIE * s.I,
    Q1: -F01c - FR - s.x1 * s.Q1 + p.k12 * s.Q2 + UG + EGP,
    Q2: s.x1 * s.Q1 - (p.k12 + s.x2) * s.Q2,
  };
}

const KEYS = ['D1', 'D2', 'S1', 'S2', 'I', 'x1', 'x2', 'x3', 'Q1', 'Q2'] as const;

/** Advances the state by `minutes` with constant insulin infusion (mU/min), RK4 with 1-min steps. */
export function step(p: HovorkaParams, s: HovorkaState, insulinMuPerMin: number, minutes: number): HovorkaState {
  let cur = s;
  const h = 1;
  for (let t = 0; t < minutes; t += h) {
    const add = (a: HovorkaState, b: HovorkaState, k: number) =>
      Object.fromEntries(KEYS.map((key) => [key, a[key] + b[key] * k])) as unknown as HovorkaState;
    const k1 = derivatives(p, cur, insulinMuPerMin);
    const k2 = derivatives(p, add(cur, k1, h / 2), insulinMuPerMin);
    const k3 = derivatives(p, add(cur, k2, h / 2), insulinMuPerMin);
    const k4 = derivatives(p, add(cur, k3, h), insulinMuPerMin);
    const next = Object.fromEntries(
      KEYS.map((key) => [key, Math.max(0, cur[key] + (h / 6) * (k1[key] + 2 * k2[key] + 2 * k3[key] + k4[key]))]),
    ) as unknown as HovorkaState;
    cur = next;
  }
  return cur;
}

/** Adds an instantaneous meal (grams of carbohydrate) to the gut compartment. */
export const addMeal = (p: HovorkaParams, s: HovorkaState, grams: number): HovorkaState => ({ ...s, D1: s.D1 + p.AG * grams * MMOL_PER_GRAM_GLUCOSE });

/** Adds an instantaneous subcutaneous bolus (units). */
export const addBolus = (s: HovorkaState, units: number): HovorkaState => ({ ...s, S1: s.S1 + units * 1000 });

/** Steady state for a constant basal (U/h); returns null if no equilibrium in range. */
export function steadyState(p: HovorkaParams, basalUph: number): HovorkaState | null {
  const u = (basalUph * 1000) / 60;
  const I = u / (p.ke * p.VI * p.BW);
  const x1 = p.SIT * I;
  const x2 = p.SID * I;
  const x3 = p.SIE * I;
  const dQ1 = (G: number) => {
    const Q1 = G * p.VG * p.BW;
    const Q2 = (x1 * Q1) / (p.k12 + x2);
    const s: HovorkaState = { D1: 0, D2: 0, S1: u * p.tmaxI, S2: u * p.tmaxI, I, x1, x2, x3, Q1, Q2 };
    return derivatives(p, s, u).Q1;
  };
  let lo = 1;
  let hi = 40;
  if (dQ1(lo) < 0 || dQ1(hi) > 0) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (dQ1(mid) > 0) lo = mid;
    else hi = mid;
  }
  const G = (lo + hi) / 2;
  const Q1 = G * p.VG * p.BW;
  return { D1: 0, D2: 0, S1: u * p.tmaxI, S2: u * p.tmaxI, I, x1, x2, x3, Q1, Q2: (x1 * Q1) / (p.k12 + x2) };
}

/** Basal rate (U/h) whose steady state sits at `targetMgdl`. */
export function basalForTarget(p: HovorkaParams, targetMgdl: number): number {
  let lo = 0.05;
  let hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const s = steadyState(p, mid);
    if (!s || glucoseMgdl(p, s) < targetMgdl) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
