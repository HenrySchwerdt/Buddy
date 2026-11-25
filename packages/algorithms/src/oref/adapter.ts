import {
  projectIob,
  scheduleValueAt,
  toNetPulses,
  insulinModelFor,
  iobFromPulses,
  DEFAULT_PEAK_MINUTES,
  MINUTE,
  HOUR,
  type AlgorithmDecision,
  type AlgorithmInput,
  type InsulinDose,
  type TherapyProfile,
} from '@buddy/core';
import determineBasal from './engine/determine-basal';
import tempBasalFunctions from './engine/basal-set-temp';
import type { OrefResult } from './engine/types';
import { drainOrefLog } from './logger';

/** Settings shared by both oref flavours. Keys mirror Trio's preference names where possible. */
export interface OrefSettings {
  readonly [key: string]: number | boolean | string;
  enableSMB: boolean;
  enableSMBAlways: boolean;
  enableSMBWithCOB: boolean;
  enableSMBAfterCarbs: boolean;
  enableSMBHighBg: boolean;
  enableSMBHighBgTarget: number;
  enableUAM: boolean;
  maxSMBBasalMinutes: number;
  maxUAMSMBBasalMinutes: number;
  smbInterval: number;
  smbDeliveryRatio: number;
  autosensMax: number;
  autosensMin: number;
  remainingCarbsCap: number;
  min5mCarbImpact: number;
  thresholdSetting: number;
  dynamicIsf: boolean;
  adjustmentFactor: number;
  skipNeutralTemps: boolean;
  highTempTargetRaisesSensitivity: boolean;
  lowTempTargetLowersSensitivity: boolean;
  sensitivityRaisesTarget: boolean;
  resistanceLowersTarget: boolean;
  halfBasalExerciseTarget: number;
  enableSMBWithTempTarget: boolean;
  allowSMBWithHighTempTarget: boolean;
  maxDeltaBGThreshold: number;
  /** Trio's Max COB: carbs on board are capped here before oref sees them. */
  maxCOB: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** 24 h total daily dose: boluses + scheduled basal + net temp-basal deviation. */
export function totalDailyDose(doses: readonly InsulinDose[], profile: TherapyProfile, now: number): number {
  const from = now - 24 * HOUR;
  const recent = doses.filter((d) => d.date >= from);
  const boluses = recent.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + d.units : s), 0);
  let scheduled = 0;
  for (let t = from; t < now; t += 5 * MINUTE) scheduled += scheduleValueAt(profile.basal, t, profile.utcOffsetMinutes) / 12;
  const netBasal = toNetPulses(recent, profile, now).filter((p) => p.isBasal).reduce((s, p) => s + p.units, 0);
  return Math.max(0, boluses + scheduled + netBasal);
}

function lastTemp(doses: readonly InsulinDose[]) {
  const temps = doses.filter((d): d is Extract<InsulinDose, { kind: 'tempBasal' }> => d.kind === 'tempBasal');
  const t = temps.reduce<(typeof temps)[number] | undefined>((a, b) => (!a || b.date > a.date ? b : a), undefined);
  return t ? { date: t.date, rate: t.rate, duration: t.durationMin, timestamp: new Date(t.date).toISOString() } : { date: 0 };
}

function buildIobData(input: AlgorithmInput) {
  const normal = projectIob(input.doses, input.profile, input.now, 240);
  const zero = projectIob(input.doses, input.profile, input.now, 240, true);
  const data = normal.map((s, i) => ({
    iob: s.iob,
    activity: s.activity,
    basaliob: s.basalIob,
    bolusiob: s.bolusIob,
    time: new Date(s.date).toISOString(),
    iobWithZeroTemp: { iob: zero[i]!.iob, activity: zero[i]!.activity, basaliob: zero[i]!.basalIob, bolusiob: zero[i]!.bolusIob },
  }));
  const lastBolusTime = input.doses.filter((d) => d.kind === 'bolus' || d.kind === 'smb').reduce((m, d) => Math.max(m, d.date), 0);
  return data.map((d, i) => (i === 0 ? { ...d, lastBolusTime, lastTemp: lastTemp(input.doses) } : d));
}

function buildProfile(input: AlgorithmInput, s: OrefSettings, tdd: number) {
  const { profile: p, limits, now } = input;
  const at = <T>(sched: readonly { startMinute: number; value: T }[]) => scheduleValueAt(sched, now, p.utcOffsetMinutes);
  const target = input.tempTarget ?? at(p.target);
  const model = insulinModelFor(p);
  return {
    current_basal: at(p.basal),
    max_daily_basal: Math.max(...p.basal.map((e) => e.value)),
    max_basal: limits.maxBasalRate,
    max_iob: limits.maxIOB,
    sens: at(p.isf),
    carb_ratio: at(p.carbRatio),
    min_bg: target.low,
    max_bg: target.high,
    target_bg: (target.low + target.high) / 2,
    temptargetSet: Boolean(input.tempTarget),
    out_units: 'mg/dL',
    dia: model.diaMinutes / 60,
    curve: p.insulinCurve,
    useCustomPeakTime: p.insulinPeakMinutes !== undefined,
    insulinPeakTime: p.insulinPeakMinutes ?? DEFAULT_PEAK_MINUTES[p.insulinCurve],
    enableSMB_always: s.enableSMBAlways,
    enableSMB_with_COB: s.enableSMBWithCOB,
    enableSMB_after_carbs: s.enableSMBAfterCarbs,
    enableSMB_with_temptarget: s.enableSMBWithTempTarget,
    enableSMB_high_bg: s.enableSMBHighBg,
    enableSMB_high_bg_target: s.enableSMBHighBgTarget,
    allowSMB_with_high_temptarget: s.allowSMBWithHighTempTarget,
    enableUAM: s.enableUAM,
    maxSMBBasalMinutes: s.maxSMBBasalMinutes,
    maxUAMSMBBasalMinutes: s.maxUAMSMBBasalMinutes,
    SMBInterval: s.smbInterval,
    bolus_increment: input.pump.bolusIncrement,
    smb_delivery_ratio: s.smbDeliveryRatio,
    maxDelta_bg_threshold: s.maxDeltaBGThreshold,
    threshold_setting: s.thresholdSetting,
    autosens_max: s.autosensMax,
    autosens_min: s.autosensMin,
    remainingCarbsCap: s.remainingCarbsCap,
    remainingCarbsFraction: 1,
    min_5m_carbimpact: s.min5mCarbImpact,
    carbsReqThreshold: 1,
    skip_neutral_temps: s.skipNeutralTemps,
    noisyCGMTargetMultiplier: 1.3,
    maxRaw: 0,
    // Trio "Target Behavior": a temp target's own half-basal target wins over the setting.
    half_basal_exercise_target: input.tempTarget?.halfBasalTarget ?? s.halfBasalExerciseTarget,
    high_temptarget_raises_sensitivity: s.highTempTargetRaisesSensitivity,
    low_temptarget_lowers_sensitivity: s.lowTempTargetLowersSensitivity,
    sensitivity_raises_target: s.sensitivityRaisesTarget,
    resistance_lowers_target: s.resistanceLowersTarget,
    exercise_mode: false,
    weightPercentage: 0.65,
    tddAdjBasal: false,
    current_basal_safety_multiplier: 4,
    max_daily_safety_multiplier: 3,
    A52_risk_enable: false,
    tdd,
  };
}

/**
 * Deviation-based carbs on board, simplified from oref0 `determine-basal/cob.js`: every
 * 5 minutes since the first meal, the glucose change not explained by insulin (deviation)
 * is attributed to carbs, but at least `min5mCarbImpact` is assumed to absorb.
 */
export function deviationCob(input: AlgorithmInput, min5mCarbImpact: number): number {
  const meals = input.carbs.filter((c) => c.date >= input.now - 6 * HOUR && c.date <= input.now);
  if (meals.length === 0) return 0;
  const first = Math.min(...meals.map((c) => c.date));
  const model = insulinModelFor(input.profile);
  const pulses = toNetPulses(input.doses, input.profile, input.now);
  const bgs = [...input.glucose].filter((g) => g.date >= first - 5 * MINUTE).sort((a, b) => a.date - b.date);
  let carbs = 0;
  let absorbed = 0;
  let mealIdx = 0;
  const sortedMeals = [...meals].sort((a, b) => a.date - b.date);
  for (let i = 1; i < bgs.length; i++) {
    const prev = bgs[i - 1]!;
    const cur = bgs[i]!;
    while (mealIdx < sortedMeals.length && sortedMeals[mealIdx]!.date <= cur.date) carbs += sortedMeals[mealIdx++]!.grams;
    if (carbs <= absorbed) continue;
    const minutes = (cur.date - prev.date) / MINUTE;
    if (minutes <= 0 || minutes > 15) continue;
    const isf = scheduleValueAt(input.profile.isf, cur.date, input.profile.utcOffsetMinutes);
    const cr = scheduleValueAt(input.profile.carbRatio, cur.date, input.profile.utcOffsetMinutes);
    const activity = iobFromPulses(pulses.filter((p) => p.date <= cur.date), model, cur.date).activity;
    const bgi = -activity * isf * minutes;
    const deviation = cur.value - prev.value - bgi;
    const impact = Math.max(deviation, (min5mCarbImpact * minutes) / 5);
    absorbed = Math.min(carbs, absorbed + (impact * cr) / isf);
  }
  while (mealIdx < sortedMeals.length) carbs += sortedMeals[mealIdx++]!.grams;
  return Math.max(0, carbs - absorbed);
}

function buildMealData(input: AlgorithmInput, s: OrefSettings) {
  const window = input.carbs.filter((c) => c.date >= input.now - 6 * HOUR);
  return {
    carbs: window.reduce((s, c) => s + c.grams, 0),
    mealCOB: r2(Math.min(s.maxCOB, deviationCob(input, s.min5mCarbImpact))),
    lastCarbTime: window.reduce((m, c) => Math.max(m, c.date), 0),
    slopeFromMaxDeviation: 0,
    slopeFromMinDeviation: 0,
    bwCarbs: false,
    bwFound: false,
  };
}

const toBasalProfile = (p: TherapyProfile) =>
  p.basal.map((e, i) => ({ i, minutes: e.startMinute, rate: e.value, start: `${String(Math.floor(e.startMinute / 60)).padStart(2, '0')}:${String(e.startMinute % 60).padStart(2, '0')}:00` }));

/**
 * Builds the positional arguments of oref's determine_basal (without tempBasalFunctions,
 * which is always the same module). Exported so tests can replay exact inputs.
 */
export function buildOrefArgs(input: AlgorithmInput, s: OrefSettings) {
  const tdd = totalDailyDose(input.doses, input.profile, input.now);
  const gs = input.glucoseStatus;
  const temp = input.pump.tempBasal;
  const remaining = temp ? Math.max(0, Math.round((temp.startedAt + temp.durationMin * MINUTE - input.now) / MINUTE)) : 0;
  const currenttemp = remaining > 0 && temp ? { rate: temp.rate, duration: remaining, temp: 'absolute' } : { rate: 0, duration: 0, temp: 'absolute' };
  const profile = buildProfile(input, s, tdd);
  // Trio's override channel (`trio_custom_oref_variables`), mapped field by field like
  // `OpenAPS.prepareTrioCustomOrefVariables`: determine-basal scales basal/ISF/CR, swaps the
  // target, turns SMBs off (always or in an hour window) and replaces max SMB/UAM minutes.
  const o = input.override;
  const overrideMinutes = Boolean(o?.overrideSmbMinutes);
  return {
    tdd,
    args: [
      { glucose: gs.glucose, delta: gs.delta, short_avgdelta: gs.shortAvgDelta, long_avgdelta: gs.longAvgDelta, date: gs.date, noise: gs.noise, device: gs.source, last_cal: 0 },
      currenttemp,
      buildIobData(input),
      profile,
      { ratio: 1 },
      buildMealData(input, s),
      s.enableSMB && !input.pump.bolusing,
      input.pump.reservoirUnits,
      new Date(input.now).toISOString(),
      [],
      { curve: input.profile.insulinCurve, useCustomPeakTime: profile.useCustomPeakTime, useNewFormula: s.dynamicIsf, sigmoid: false, adjustmentFactor: s.adjustmentFactor, adjustmentFactorSigmoid: 0.5 },
      toBasalProfile(input.profile),
      {
        overrideTarget: o?.target ?? 0,
        useOverride: Boolean(o),
        overridePercentage: o?.percentage ?? 100,
        duration: overrideRemainingMin(input),
        unlimited: o ? o.durationMin === null : true,
        // Buddy's SMB-off algorithm setting rides on the same flag (oref also gets microBolusAllowed = false).
        smbIsOff: !s.enableSMB || Boolean(o?.disableSmb),
        smbIsScheduledOff: Boolean(o?.smbIsScheduledOff),
        start: o?.smbIsScheduledOff ? (o.smbOffStartHour ?? 0) : 0,
        end: o?.smbIsScheduledOff ? (o.smbOffEndHour ?? 0) : 0,
        advancedSettings: overrideMinutes,
        isfAndCr: Boolean(o?.scaleIsf && o?.scaleCr),
        isf: Boolean(o?.scaleIsf),
        cr: Boolean(o?.scaleCr),
        smbMinutes: overrideMinutes ? (o?.smbMinutes ?? s.maxSMBBasalMinutes) : s.maxSMBBasalMinutes,
        uamMinutes: overrideMinutes ? (o?.uamMinutes ?? s.maxUAMSMBBasalMinutes) : s.maxUAMSMBBasalMinutes,
        currentTDD: tdd, weightedAverage: tdd, average_total_data: tdd,
      },
      '',
    ],
  } as const;
}

/** Trio passes the override's configured duration (0 = indefinite); determine-basal only logs it. */
function overrideRemainingMin(input: AlgorithmInput): number {
  const o = input.override;
  if (!o || o.durationMin === null) return 0;
  return o.durationMin;
}

/** Runs Trio's oref determine-basal on a Buddy input snapshot. */
export function runOref(input: AlgorithmInput, s: OrefSettings): AlgorithmDecision {
  drainOrefLog();
  const { tdd, args } = buildOrefArgs(input, s);
  const [glucoseStatus, currenttemp, iobData, profile, autosens, meal, smbAllowed, reservoir, time, pumphistory, preferences, basalProfile, custom, middleware] = args;
  const rT: OrefResult = determineBasal(glucoseStatus, currenttemp, iobData, profile, autosens, meal, tempBasalFunctions, smbAllowed, reservoir, time, [...pumphistory], preferences, basalProfile, custom, middleware);
  const log = drainOrefLog();

  if (rT.error) return { reason: String(rT.error), debug: { log: log.slice(-40).join('\n') } };

  const tempBasal = typeof rT.rate === 'number' && typeof rT.duration === 'number'
    ? rT.duration === 0 ? null : { rate: rT.rate, durationMin: rT.duration }
    : undefined;

  return {
    tempBasal,
    autoBolus: typeof rT.units === 'number' && rT.units > 0 ? rT.units : undefined,
    predictions: rT.predBGs ? { iob: rT.predBGs.IOB, zt: rT.predBGs.ZT, cob: rT.predBGs.COB, uam: rT.predBGs.UAM } : undefined,
    eventualGlucose: num(rT.eventualBG),
    insulinReq: num(rT.insulinReq),
    carbsReq: num(rT.carbsReq),
    sensitivityRatio: num(rT.sensitivityRatio),
    reason: String(rT.reason ?? ''),
    debug: {
      ISF: num(rT.ISF) ?? 0,
      CR: num(rT.CR) ?? 0,
      TDD: r2(tdd),
      BGI: num(rT.BGI) ?? 0,
      deviation: num(rT.deviation) ?? 0,
      minPredBG: num(rT.minPredBG) ?? 0,
      minGuardBG: num(rT.minGuardBG) ?? 0,
      target: num(rT.target_bg) ?? 0,
      log: log.slice(-40).join('\n'),
    },
  };
}


const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x !== '' && Number.isFinite(Number(x)) ? Number(x) : undefined);
