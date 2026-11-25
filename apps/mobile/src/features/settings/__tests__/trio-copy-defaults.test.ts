import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_LIMITS, DEFAULT_PEAK_MINUTES, DEFAULT_PROFILE } from '@buddy/core';
import { orefSmb, orefTempBasal } from '@buddy/algorithms';
import { DEFAULT_TREATMENT_SETTINGS } from '@/features/treatment/settings-store';
import { DEFAULT_SETTINGS } from '@/runtime/settings-store';
import { DEFAULT_TRIO_PREFS } from '../store';
import { TRIO_COPY, type TrioCopyKey } from '../trio-copy';
import type { TrioSettingCopy } from '../types';

vi.mock('expo-sqlite/kv-store', () => ({ default: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } }));

/** The text after "Default: " in a hint (the `**Default: …` line). */
function statedDefault(key: TrioCopyKey, prefix = 'Default: '): string {
  const hint: readonly string[] = TRIO_COPY[key].hint;
  const line = hint.find((l) => l.startsWith(`**${prefix}`));
  if (!line) throw new Error(`${key}: no "${prefix}" line`);
  return line.slice(prefix.length + 2);
}

const onOff = (v: boolean) => (v ? 'ON' : 'OFF');
const pct = (v: number) => `${Math.round(v * 100)}%`;
const smb = orefSmb.defaultSettings;

describe('trio-copy "Default:" lines match Buddy defaults', () => {
  test('delivery limits (SafetyLimits)', () => {
    expect(statedDefault('maxIOB')).toBe(`${DEFAULT_LIMITS.maxIOB} units`);
    expect(statedDefault('maxBolus')).toBe(`${DEFAULT_LIMITS.maxBolus} units`);
    expect(statedDefault('maxBasal')).toBe(`${DEFAULT_LIMITS.maxBasalRate} U/hr`);
    expect(statedDefault('maxCOB')).toBe(`${DEFAULT_TREATMENT_SETTINGS.maxCOB} grams of carbs`);
  });

  test('minimum safety threshold states the oref default, not "set by algorithm"', () => {
    expect(statedDefault('threshold_setting')).toBe(`{g:${smb.thresholdSetting}} {unit}`);
  });

  test('oref SMB defaults', () => {
    expect(statedDefault('enableSMBAlways')).toBe(onOff(Boolean(smb.enableSMBAlways)));
    expect(statedDefault('enableSMBWithCOB')).toBe(onOff(Boolean(smb.enableSMBWithCOB)));
    expect(statedDefault('enableSMBWithTemptarget')).toBe(onOff(Boolean(smb.enableSMBWithTempTarget)));
    expect(statedDefault('enableSMBAfterCarbs')).toBe(onOff(Boolean(smb.enableSMBAfterCarbs)));
    expect(statedDefault('enableSMB_high_bg')).toBe(onOff(Boolean(smb.enableSMBHighBg)));
    expect(statedDefault('allowSMBWithHighTemptarget')).toBe(onOff(Boolean(smb.allowSMBWithHighTempTarget)));
    expect(statedDefault('enableUAM')).toBe(onOff(Boolean(smb.enableUAM)));
    expect(statedDefault('maxSMBBasalMinutes')).toBe(`${smb.maxSMBBasalMinutes} minutes`);
    expect(statedDefault('maxUAMSMBBasalMinutes')).toBe(`${smb.maxUAMSMBBasalMinutes} minutes`);
    expect(statedDefault('maxDeltaBGthreshold')).toBe(`${pct(Number(smb.maxDeltaBGThreshold))} increase`);
    expect(statedDefault('smbDeliveryRatio')).toBe(pct(Number(smb.smbDeliveryRatio)));
    expect(statedDefault('smbInterval')).toBe(`${smb.smbInterval} min`);
  });

  test('the temp-basal flavour has SMB and UAM off (screens disable these rows)', () => {
    expect(orefTempBasal.defaultSettings.enableSMB).toBe(false);
    expect(orefTempBasal.defaultSettings.enableUAM).toBe(false);
  });

  test('autosens, dynamic ISF and target behaviour', () => {
    expect(statedDefault('autosensMax')).toBe(pct(Number(smb.autosensMax)));
    expect(statedDefault('autosensMin')).toBe(pct(Number(smb.autosensMin)));
    expect(statedDefault('adjustmentFactor')).toBe(pct(Number(smb.adjustmentFactor)));
    expect(statedDefault('highTemptargetRaisesSensitivity')).toBe(onOff(Boolean(smb.highTempTargetRaisesSensitivity)));
    expect(statedDefault('lowTemptargetLowersSensitivity')).toBe(onOff(Boolean(smb.lowTempTargetLowersSensitivity)));
    expect(statedDefault('sensitivityRaisesTarget')).toBe(onOff(Boolean(smb.sensitivityRaisesTarget)));
    expect(statedDefault('resistanceLowersTarget')).toBe(onOff(Boolean(smb.resistanceLowersTarget)));
    expect(statedDefault('halfBasalExerciseTarget')).toBe(`{g:${smb.halfBasalExerciseTarget}} {unit}`);
    expect(statedDefault('skipNeutralTemps')).toBe(onOff(Boolean(smb.skipNeutralTemps)));
    expect(statedDefault('remainingCarbsCap')).toBe(`${smb.remainingCarbsCap} g`);
  });

  // These values are hard-coded in the oref adapter / settings screens (shown read-only).
  // If you change them there, change the help text as well.
  test('values the oref adapter fixes', () => {
    expect(statedDefault('weightPercentage')).toBe(pct(0.65));
    expect(statedDefault('rewindResetsAutosens')).toBe(onOff(false));
    expect(statedDefault('tddAdjBasal')).toBe(onOff(false));
    expect(statedDefault('unsuspendIfNoTemp')).toBe(onOff(false));
    expect(statedDefault('maxDailySafetyMultiplier')).toBe(pct(3));
    expect(statedDefault('currentBasalSafetyMultiplier')).toBe(pct(4));
    expect(statedDefault('remainingCarbsFraction')).toBe(pct(1));
    expect(statedDefault('noisyCGMTargetMultiplier')).toBe(pct(1.3));
  });

  test('insulin action: profile DIA and per-curve peak times', () => {
    expect(statedDefault('insulinActionCurve')).toBe(`${DEFAULT_PROFILE.diaHours} hours`);
    const hint = TRIO_COPY.useCustomPeakTime.hint.join('\n');
    expect(hint).toContain(`Ultra-Rapid: ${DEFAULT_PEAK_MINUTES['ultra-rapid']} minutes`);
    expect(hint).toContain(`Rapid-Acting: ${DEFAULT_PEAK_MINUTES['rapid-acting']} minutes`);
  });

  test('bolus calculator and meal settings', () => {
    const t = DEFAULT_TREATMENT_SETTINGS;
    expect(statedDefault('overrideFactor')).toBe(pct(DEFAULT_SETTINGS.bolusFraction));
    expect(statedDefault('displayPresets')).toBe(onOff(t.displayPresets));
    expect(statedDefault('fattyMeals')).toBe(onOff(t.fattyMeals));
    expect(statedDefault('fattyMeals', 'Default Percent: ')).toBe(pct(t.fattyMealFactor));
    expect(statedDefault('sweetMeals')).toBe(onOff(t.sweetMeals));
    expect(statedDefault('sweetMeals', 'Default Percent: ')).toBe(pct(t.sweetMealFactor));
    expect(statedDefault('confirmBolusWhenVeryLowGlucose')).toBe(onOff(t.confirmBolus));
    expect(statedDefault('useFPUconversion')).toBe(onOff(t.useFPUconversion));
    expect(statedDefault('delay')).toBe(`${t.delay} min`);
    expect(statedDefault('minuteInterval')).toBe(`${t.minuteInterval} minutes`);
    expect(statedDefault('individualAdjustmentFactor')).toBe(pct(t.individualAdjustmentFactor));
    expect(statedDefault('maxMealAbsorptionTime')).toBe(`${DEFAULT_TRIO_PREFS.maxMealAbsorptionTime} hours`);
  });

  test('feature toggles', () => {
    expect(statedDefault('allowBolusByShortcuts')).toBe(onOff(DEFAULT_TRIO_PREFS.allowBolusByShortcuts));
    expect(statedDefault('isTrioRemoteControlEnabled')).toBe(onOff(DEFAULT_TRIO_PREFS.isTrioRemoteControlEnabled));
    expect(statedDefault('enableQuickPickTreatments')).toBe(onOff(DEFAULT_TRIO_PREFS.enableQuickPickTreatments));
  });

  test('min 5m carb impact body text quotes the default', () => {
    expect(TRIO_COPY.min5mCarbimpact.hint.join('\n')).toContain(`{g:${smb.min5mCarbImpact}} {unit}/5min`);
  });

  test('help text names the running app Buddy, not Trio', () => {
    const all = (Object.values(TRIO_COPY) as TrioSettingCopy[]).flatMap((c) => [c.label, c.miniHint, c.header ?? '', ...c.hint]);
    expect(all.filter((t) => /\bTrio\b/.test(t))).toEqual([]);
  });
});
