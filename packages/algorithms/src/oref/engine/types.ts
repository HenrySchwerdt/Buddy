/**
 * Types for the oref determine-basal engine (TypeScript port of Trio's trio-oref).
 * Field names intentionally keep oref's snake_case so the port stays line-by-line
 * comparable with upstream.
 */

export interface OrefGlucoseStatus {
  glucose: number;
  delta: number;
  short_avgdelta: number;
  long_avgdelta: number;
  date: number;
  noise: number;
  device: string;
  last_cal: number;
}

export interface OrefCurrentTemp {
  rate: number;
  duration: number;
  temp: string;
}

export interface OrefIobValues {
  iob: number;
  activity: number;
  basaliob: number;
  bolusiob: number;
}

export interface OrefIobTick extends OrefIobValues {
  time: string;
  iobWithZeroTemp: OrefIobValues;
  lastBolusTime?: number;
  lastTemp?: { date: number; rate?: number; duration?: number; timestamp?: string };
}

export interface OrefProfile {
  current_basal: number;
  max_daily_basal: number;
  max_basal: number;
  max_iob: number;
  sens: number;
  carb_ratio: number;
  min_bg: number;
  max_bg: number;
  target_bg: number;
  temptargetSet: boolean;
  out_units: string;
  dia: number;
  curve: string;
  useCustomPeakTime: boolean;
  insulinPeakTime: number;
  enableSMB_always: boolean;
  enableSMB_with_COB: boolean;
  enableSMB_after_carbs: boolean;
  enableSMB_with_temptarget: boolean;
  enableSMB_high_bg: boolean;
  enableSMB_high_bg_target: number;
  allowSMB_with_high_temptarget: boolean;
  enableUAM: boolean;
  maxSMBBasalMinutes: number;
  maxUAMSMBBasalMinutes: number;
  SMBInterval: number;
  bolus_increment: number;
  smb_delivery_ratio: number;
  maxDelta_bg_threshold: number;
  threshold_setting: number;
  autosens_max: number;
  autosens_min: number;
  remainingCarbsCap: number;
  remainingCarbsFraction: number;
  min_5m_carbimpact: number;
  carbsReqThreshold: number;
  skip_neutral_temps: boolean;
  noisyCGMTargetMultiplier: number;
  maxRaw: number;
  half_basal_exercise_target: number;
  high_temptarget_raises_sensitivity: boolean;
  low_temptarget_lowers_sensitivity: boolean;
  sensitivity_raises_target: boolean;
  resistance_lowers_target: boolean;
  exercise_mode: boolean;
  weightPercentage: number;
  tddAdjBasal: boolean;
  current_basal_safety_multiplier: number;
  max_daily_safety_multiplier: number;
  A52_risk_enable: boolean;
  model?: string;
  tdd?: number;
}

export interface OrefAutosens {
  ratio: number;
}

export interface OrefMealData {
  carbs: number;
  mealCOB: number;
  lastCarbTime: number;
  slopeFromMaxDeviation: number;
  slopeFromMinDeviation: number;
  bwCarbs: boolean;
  bwFound: boolean;
  reason?: string;
}

export interface OrefPreferences {
  curve: string;
  useCustomPeakTime: boolean;
  useNewFormula: boolean;
  sigmoid: boolean;
  adjustmentFactor: number;
  adjustmentFactorSigmoid: number;
}

export interface OrefBasalProfileEntry {
  i: number;
  minutes: number;
  rate: number;
  start: string;
}

export interface TrioCustomVariables {
  overrideTarget: number;
  useOverride: boolean;
  overridePercentage: number;
  duration: number;
  smbIsOff: boolean;
  smbIsScheduledOff: boolean;
  start: number;
  end: number;
  advancedSettings: boolean;
  isfAndCr: boolean;
  isf: boolean;
  cr: boolean;
  smbMinutes: number;
  uamMinutes: number;
  currentTDD: number;
  weightedAverage: number;
  average_total_data: number;
}

export interface OrefPredBGs {
  IOB?: number[];
  ZT?: number[];
  COB?: number[];
  aCOB?: number[];
  UAM?: number[];
}

/** determine-basal's result ("requested temp"); built up field by field like upstream. */
export interface OrefResult {
  temp?: string;
  bg?: number;
  tick?: string | number;
  eventualBG?: number;
  insulinReq?: number;
  reservoir?: number | null;
  deliverAt?: Date;
  sensitivityRatio?: number;
  CR?: number;
  current_target?: number;
  insulinForManualBolus?: number;
  manualBolusErrorString?: number;
  minDelta?: number;
  expectedDelta?: number;
  minGuardBG?: number;
  minPredBG?: number;
  threshold?: number;
  TDD?: number;
  ISF?: number;
  BGI?: number;
  deviation?: number;
  target_bg?: number;
  carbsReq?: number;
  predBGs?: OrefPredBGs;
  COB?: number;
  IOB?: number;
  reason: string;
  error?: string;
  rate?: number;
  duration?: number;
  units?: number;
}

export interface TempBasalFunctions {
  getMaxSafeBasal(profile: OrefProfile): number;
  setTempBasal(rate: number, duration: number, profile: OrefProfile, rT: OrefResult, currenttemp?: OrefCurrentTemp): OrefResult;
}
