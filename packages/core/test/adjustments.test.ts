import { describe, expect, it } from 'vitest';
import {
  computeAdjustedPercentage,
  computeEffectiveHBT,
  computeHalfBasalTarget,
  DEFAULT_OVERRIDE_PRESETS,
  DEFAULT_TARGET_BEHAVIOR,
  DEFAULT_TEMP_TARGET_PRESETS,
  disableSmbFlags,
  disableSmbModeOf,
  effectiveSettings,
  inverseChangeFlags,
  inverseChangeOf,
  isAdjustSensEnabled,
  isInSmbOffWindow,
  isOverrideActive,
  isTempTargetActive,
  isTempTargetScheduled,
  overrideDraftError,
  percentageDescription,
  roundOverridePercentageToStep,
  roundTargetToStep,
  targetPickerValues,
  tempTargetDraftError,
  tempTargetPresetError,
  ttSliderRange,
  validateOverride,
  validateTempTarget,
  type ActiveOverride,
  type OverrideDraftCheck,
} from '../src';
import { flatProfile, T0 } from './fixtures';

const MIN = 60_000;
const exercise: ActiveOverride = { id: 'exercise', name: 'Exercise', percentage: 50, target: 150, scaleIsf: true, scaleCr: true, disableSmb: true, durationMin: 90, startedAt: T0 };

describe('effectiveSettings', () => {
  it('scales basal, ISF and CR and applies the override target', () => {
    const e = effectiveSettings(flatProfile, T0 + MIN, exercise);
    expect(e.basal).toBe(0.5);
    expect(e.isf).toBe(100);
    expect(e.carbRatio).toBe(20);
    expect(e.target).toEqual({ low: 150, high: 150 });
    expect(e.smbDisabled).toBe(true);
    expect(e.maxSmbMinutes).toBeNull();
  });

  it('expires and lets temp targets win', () => {
    expect(isOverrideActive(exercise, T0 + 91 * MIN)).toBe(false);
    expect(effectiveSettings(flatProfile, T0 + MIN, exercise, { low: 80, high: 80 }).target).toEqual({ low: 80, high: 80 });
  });

  it.each([
    ['isfAndCr', 100, 20],
    ['isf', 100, 10],
    ['cr', 50, 20],
    ['none', 50, 10],
  ] as const)('inverse change %s scales ISF to %d and CR to %d', (mode, isf, cr) => {
    const e = effectiveSettings(flatProfile, T0 + MIN, { ...exercise, ...inverseChangeFlags(mode) });
    expect(e.basal).toBe(0.5);
    expect(e.isf).toBe(isf);
    expect(e.carbRatio).toBe(cr);
  });

  it('turns SMBs off only inside the scheduled window (T0 is 12:00 UTC)', () => {
    const scheduled = { ...exercise, disableSmb: false, smbIsScheduledOff: true };
    expect(effectiveSettings(flatProfile, T0 + MIN, { ...scheduled, smbOffStartHour: 10, smbOffEndHour: 14 }).smbDisabled).toBe(true);
    expect(effectiveSettings(flatProfile, T0 + MIN, { ...scheduled, smbOffStartHour: 22, smbOffEndHour: 6 }).smbDisabled).toBe(false);
    expect(effectiveSettings(flatProfile, T0 + MIN, { ...scheduled, smbOffStartHour: 0, smbOffEndHour: 0 }).smbDisabled).toBe(true);
  });

  it('exposes override SMB/UAM minutes only with the toggle on and SMBs not off', () => {
    const o = { ...exercise, disableSmb: false, overrideSmbMinutes: true, smbMinutes: 60, uamMinutes: 90 };
    const e = effectiveSettings(flatProfile, T0 + MIN, o);
    expect([e.maxSmbMinutes, e.maxUamMinutes]).toEqual([60, 90]);
    expect(effectiveSettings(flatProfile, T0 + MIN, { ...o, overrideSmbMinutes: false }).maxSmbMinutes).toBeNull();
  });

  it('treats a 0 override target like Trio (no target)', () => {
    expect(effectiveSettings(flatProfile, T0 + MIN, { ...exercise, target: 0 }).target).toEqual({ low: 100, high: 100 });
  });
});

describe('modes and windows', () => {
  it('round-trips inverse change and SMB modes', () => {
    for (const m of ['isfAndCr', 'isf', 'cr', 'none'] as const) expect(inverseChangeOf(inverseChangeFlags(m))).toBe(m);
    for (const m of ['dontDisable', 'disable', 'disableOnSchedule'] as const) expect(disableSmbModeOf(disableSmbFlags(m))).toBe(m);
  });

  it('matches oref enable_smb window rules', () => {
    expect(isInSmbOffWindow(10, 14, 13)).toBe(true);
    expect(isInSmbOffWindow(10, 14, 14)).toBe(false);
    expect(isInSmbOffWindow(22, 6, 23)).toBe(true);
    expect(isInSmbOffWindow(22, 6, 5)).toBe(true);
    expect(isInSmbOffWindow(22, 6, 12)).toBe(false);
    expect(isInSmbOffWindow(5, 5, 5)).toBe(true);
    expect(isInSmbOffWindow(5, 5, 6)).toBe(false);
  });

  it('knows scheduled and active temp targets', () => {
    const tt = { id: 't', name: 't', target: 120, durationMin: 60, startedAt: T0 + 30 * MIN };
    expect(isTempTargetScheduled(tt, T0)).toBe(true);
    expect(isTempTargetActive(tt, T0)).toBe(false);
    expect(isTempTargetActive(tt, T0 + 31 * MIN)).toBe(true);
  });
});

describe('validation (Trio copy)', () => {
  const draft: OverrideDraftCheck = { percentage: 100, indefinite: true, durationMin: 0, overrideTarget: false, target: 100, overrideSmbMinutes: false, disableSmb: false, smbIsScheduledOff: false };

  it('reports the first override problem', () => {
    expect(overrideDraftError(draft, 'mg/dL')).toBe('All settings are at default values.');
    expect(overrideDraftError({ ...draft, indefinite: false }, 'mg/dL')).toBe('Enable indefinitely or set a duration.');
    expect(overrideDraftError({ ...draft, overrideTarget: true, target: 300 }, 'mmol/L')).toBe('Target glucose is out of range (4-14).');
    expect(overrideDraftError({ ...draft, percentage: 80 }, 'mg/dL')).toBeNull();
    expect(overrideDraftError({ ...draft, smbIsScheduledOff: true }, 'mg/dL')).toBeNull();
  });

  it('reports temp target problems', () => {
    expect(tempTargetDraftError({ target: 100, durationMin: 0 }, 'mg/dL')).toBe('Set a duration!');
    expect(tempTargetDraftError({ target: 75, durationMin: 30 }, 'mg/dL')).toBe('80 mg/dL needed as min. Glucose Target)!');
    expect(tempTargetPresetError({ target: 100, durationMin: 30, startAt: T0 + MIN }, T0, 'mg/dL')).toBe('Presets cannot be saved with a future date!');
    expect(tempTargetPresetError({ target: 100, durationMin: 30, startAt: T0 }, T0, 'mg/dL')).toBeNull();
  });

  it('validates stored ranges', () => {
    expect(validateOverride({ ...exercise, percentage: 500 })).toHaveLength(1);
    expect(validateOverride({ ...exercise, smbIsScheduledOff: true, smbOffStartHour: 24 })).toHaveLength(1);
    expect(validateTempTarget({ id: 't', name: 't', target: 75, durationMin: 30 })).toHaveLength(1);
  });

  it('describes percentages', () => {
    expect(percentageDescription(100)).toBeNull();
    expect(percentageDescription(80)).toBe('Insulin doses will be decreased by 20 %.');
    expect(percentageDescription(120)).toBe('Insulin doses will be increased by 20 %.');
  });
});

describe('picker rounding', () => {
  it('snaps percentages towards 100', () => {
    expect(roundOverridePercentageToStep(87, 5)).toBe(90);
    expect(roundOverridePercentageToStep(113, 5)).toBe(110);
    expect(roundOverridePercentageToStep(90, 5)).toBe(90);
  });
  it('rounds targets up and builds picker values', () => {
    expect(roundTargetToStep(101, 5)).toBe(105);
    expect(targetPickerValues(72, 90, 5)).toEqual([75, 80, 85, 90]);
  });
});

describe('temp target sensitivity (TempTargetCalculations)', () => {
  it('computes the half-basal percentage', () => {
    expect(computeAdjustedPercentage(160, 120, 1.2)).toBeCloseTo(75);
    expect(computeAdjustedPercentage(110, 200, 1.2)).toBe(15);
    expect(computeAdjustedPercentage(160, 80, 1.2)).toBeCloseTo(120);
  });
  it('inverts to a half-basal target', () => {
    expect(computeHalfBasalTarget(120, 75)).toBe(160);
    expect(computeHalfBasalTarget(120, 100)).toBe(160);
  });
  it('adjusts the HBT for standard targets that would fall below 15 %', () => {
    expect(computeEffectiveHBT(null, 160, 120, 1.2)).toBeNull();
    expect(computeEffectiveHBT(170, 160, 120, 1.2)).toBe(170);
    expect(computeEffectiveHBT(null, 110, 200, 1.2)).toBe(computeHalfBasalTarget(200, 15));
  });
  it('enables sensitivity adjustment only per Target Behavior', () => {
    expect(isAdjustSensEnabled(140, DEFAULT_TARGET_BEHAVIOR)).toBe(false);
    expect(isAdjustSensEnabled(140, { ...DEFAULT_TARGET_BEHAVIOR, highTemptargetRaisesSensitivity: true })).toBe(true);
    expect(isAdjustSensEnabled(80, { ...DEFAULT_TARGET_BEHAVIOR, lowTemptargetLowersSensitivity: true, autosensMax: 1 })).toBe(false);
    expect(ttSliderRange(140, 1.2)).toEqual({ low: 15, high: 95 });
    expect(ttSliderRange(80, 1.2)).toEqual({ low: 105, high: 120 });
  });
});

it('ships without presets like Trio', () => {
  expect(DEFAULT_OVERRIDE_PRESETS).toHaveLength(0);
  expect(DEFAULT_TEMP_TARGET_PRESETS).toHaveLength(0);
});
