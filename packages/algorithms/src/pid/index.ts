import { defineAlgorithm, effectiveSettings, MINUTE, type AlgorithmDecision } from '@buddy/core';
import { predictGlucose } from '../shared/predict';

export interface PidSettings {
  readonly [key: string]: number | boolean | string;
  responseHours: number;
  integralMinutes: number;
  derivativeMinutes: number;
  insulinFeedback: number;
}

const TEMP_DURATION = 30;
const INTEGRAL_WINDOW_MIN = 180;
const INTEGRAL_HALF_LIFE_MIN = 60;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * PID controller with insulin feedback (after Steil et al., "PID-IFB"). Gain is expressed
 * physiologically: the proportional term corrects the current error within `responseHours`
 * using the user's ISF, so the tuning carries across people.
 */
export const pid = defineAlgorithm<PidSettings>({
  meta: {
    id: 'pid-ifb',
    name: 'PID with insulin feedback',
    shortName: 'PID',
    description: 'Classic control-theory approach: proportional, integral and derivative terms on the glucose error, damped by insulin on board. Temp basal only, no meal model.',
    version: '1.0.0',
    author: 'Buddy contributors',
    maturity: 'experimental',
    capabilities: { tempBasal: true, autoBolus: false, predictions: ['main'] },
  },
  settings: [
    {
      title: 'Controller',
      fields: [
        { kind: 'number', key: 'responseHours', label: 'Response time', help: 'Lower = more aggressive proportional action.', unit: 'h', min: 1, max: 6, step: 0.5, affectsDosing: true },
        { kind: 'number', key: 'integralMinutes', label: 'Integral time (Ti)', unit: 'min', min: 60, max: 600, step: 30, affectsDosing: true },
        { kind: 'number', key: 'derivativeMinutes', label: 'Derivative time (Td)', unit: 'min', min: 0, max: 120, step: 10, affectsDosing: true },
        { kind: 'number', key: 'insulinFeedback', label: 'Insulin feedback (γ)', help: 'How strongly IOB damps the output.', min: 0, max: 1, step: 0.05 },
      ],
    },
  ],
  defaultSettings: { responseHours: 2.5, integralMinutes: 240, derivativeMinutes: 60, insulinFeedback: 0.5 },
  decide(input, s): AlgorithmDecision {
    const { profile, now, glucoseStatus, glucose } = input;
    const eff = effectiveSettings(profile, now, input.override, input.tempTarget);
    const basal = eff.basal;
    const isf = eff.isf;
    const range = eff.target;
    const target = (range.low + range.high) / 2;
    const kp = 1 / (isf * s.responseHours); // U/h per mg/dL

    const error = glucoseStatus.glucose - target;
    const derivative = (glucoseStatus.shortAvgDelta || glucoseStatus.delta) / 5; // mg/dL/min
    // Anti-windup: exponentially forget old error, and drop the integral entirely when the
    // 30-minute trend projects below target (conditional integration).
    const window = glucose.filter((g) => g.date >= now - INTEGRAL_WINDOW_MIN * MINUTE);
    const decay = (g: { date: number }) => Math.pow(0.5, (now - g.date) / MINUTE / INTEGRAL_HALF_LIFE_MIN);
    const headingBelowTarget = glucoseStatus.glucose + derivative * 30 < target;
    const integral = headingBelowTarget ? 0 : window.reduce((sum, g) => sum + (g.value - target) * 5 * decay(g), 0); // mg/dL·min

    const p = kp * error;
    const iTerm = Math.max(-basal, Math.min(basal * 2, (kp * integral) / s.integralMinutes));
    const d = kp * s.derivativeMinutes * derivative;
    const feedback = (s.insulinFeedback * input.iob.iob) / s.responseHours;
    const rate = Math.max(0, basal + p + iTerm + d - feedback);

    const main = predictGlucose(input, { horizonMinutes: 180, momentumMinutes: 15 });
    return {
      tempBasal: Math.abs(rate - basal) < 0.05 ? null : { rate: r2(rate), durationMin: TEMP_DURATION },
      predictions: { main },
      eventualGlucose: main.at(-1),
      reason: `PID: P ${r2(p)} + I ${r2(iTerm)} + D ${r2(d)} − IFB ${r2(feedback)} → ${r2(rate)} U/h (basal ${basal}).`,
      debug: { P: r2(p), I: r2(iTerm), D: r2(d), IFB: r2(feedback), error: Math.round(error) },
    };
  },
});
