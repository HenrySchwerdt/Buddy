import { describe, expect, test } from 'vitest';
import { DEFAULT_LIMITS, DEFAULT_PROFILE } from '@buddy/core';
import {
  DEFAULT_DRAFT,
  scheduleStepIncomplete,
  PICKERS,
  PUMP_MODELS,
  addItem,
  buildSettings,
  cannotAddMore,
  fmtBasal,
  importTherapy,
  newItem,
  normalizeNightscoutUrl,
  pickerValues,
  snapItems,
  suggestedMaxIOB,
  totalDailyBasal,
  validateItems,
} from '../logic';
import { INITIAL_NAV, PROGRESS_STEPS, backNav, nextNav, segmentFill, type NavContext, type NavState } from '../model';

const ctx: NavContext = { nightscoutSetup: 'skip', enableSMBAlways: false, reportsRewindEvents: false };

describe('picker values', () => {
  test('generates exact decimal grids', () => {
    const cr = pickerValues(PICKERS.carbRatio, 'mg/dL');
    expect(cr[0]).toBe(1);
    expect(cr[cr.length - 1]).toBe(50);
    expect(cr).toContain(10.3);
    expect(pickerValues(PICKERS.autosensMin, 'mg/dL')).toEqual([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]);
  });

  test('drops glucose values that round to the same mmol/L', () => {
    const mgdl = pickerValues(PICKERS.target, 'mg/dL');
    const mmol = pickerValues(PICKERS.target, 'mmol/L');
    expect(mgdl).toHaveLength(109);
    expect(mmol.length).toBeLessThan(mgdl.length);
    expect(new Set(mmol.map((v) => (v / 18.0182).toFixed(1))).size).toBe(mmol.length);
  });
});

describe('schedules', () => {
  test('validate dedupes times, sorts and forces 00:00', () => {
    const out = validateItems([newItem(3600, 1), newItem(1800, 2), newItem(3600, 3)]);
    expect(out.map((i) => [i.time, i.value])).toEqual([
      [0, 2],
      [3600, 1],
    ]);
  });

  test('add appends half an hour later, capped at 23:30', () => {
    const items = addItem([newItem(0, 0.8)]);
    expect(items[1]).toMatchObject({ time: 1800, value: 0.8 });
    const late = [newItem(0, 1), newItem(84_600, 1)];
    expect(cannotAddMore(late)).toBe(true);
  });

  test('snap maps values onto a pump basal grid', () => {
    const dana = PUMP_MODELS.find((p) => p.id === 'Dana')!;
    const options = pickerValues({ ...dana.basal, kind: 'insulinUnitPerHour' }, 'mg/dL');
    expect(snapItems([newItem(0, 4.2)], options)[0]!.value).toBe(3);
    expect(snapItems([newItem(0, 0.123)], options)[0]!.value).toBe(0.12);
  });

  test('total daily basal and Max IOB suggestion', () => {
    const basal = [newItem(0, 1), newItem(12 * 3600, 2)];
    expect(totalDailyBasal(basal)).toBe(36);
    expect(suggestedMaxIOB(36)).toBe(12);
    expect(suggestedMaxIOB(1000)).toBe(30);
    expect(fmtBasal(0.1)).toBe('0.10');
    expect(fmtBasal(0.025)).toBe('0.025');
  });
});

describe('navigation', () => {
  const walk = (from: NavState, steps: number, c = ctx) => Array.from({ length: steps }).reduce<NavState>((n) => nextNav(n, c), from);

  test('welcome → disclaimer → startup guide → force-close warning → overview (returning-user page skipped)', () => {
    const seq = [INITIAL_NAV];
    for (let i = 0; i < 4; i++) seq.push(nextNav(seq[seq.length - 1]!, ctx));
    expect(seq.map((n) => `${n.step}:${n.startup}`)).toEqual(['welcome:0', 'disclaimer:0', 'startupInfo:0', 'startupInfo:2', 'overview:0']);
    expect(backNav(seq[4]!, ctx)).toMatchObject({ step: 'startupInfo', startup: 2 });
    expect(backNav(seq[3]!, ctx)).toMatchObject({ step: 'startupInfo', startup: 0 });
  });

  test('skipping Nightscout goes straight to units, then shows the chapter completion', () => {
    const ns: NavState = { ...INITIAL_NAV, step: 'nightscout' };
    const units = nextNav(ns, ctx);
    expect(units.step).toBe('unitSelection');
    const done = nextNav(units, ctx);
    expect(done).toMatchObject({ step: 'unitSelection', chapterCompletion: 'prepare' });
    expect(nextNav(done, ctx)).toMatchObject({ step: 'glucoseTarget', chapterCompletion: null });
    expect(segmentFill('nightscout', units, ctx)).toBe(1);
  });

  test('Nightscout setup walks all five substeps', () => {
    const c = { ...ctx, nightscoutSetup: 'setup' as const };
    const end = walk({ ...INITIAL_NAV, step: 'nightscout' }, 4, c);
    expect(end).toMatchObject({ step: 'nightscout', nightscout: 4 });
    expect(nextNav(end, c).step).toBe('unitSelection');
  });

  test('delivery limits end with a chapter completion and back returns to the last substep', () => {
    const last = walk({ ...INITIAL_NAV, step: 'deliveryLimits' }, 4);
    expect(last.delivery).toBe(4);
    const completion = nextNav(last, ctx);
    expect(completion.chapterCompletion).toBe('delivery');
    expect(nextNav(completion, ctx).step).toBe('algorithmSettings');
    expect(backNav({ ...INITIAL_NAV, step: 'algorithmSettings' }, ctx)).toMatchObject({ step: 'deliveryLimits', delivery: 4 });
  });

  test('autosens shows the rewind question only for pumps that report rewinds', () => {
    const start: NavState = { ...INITIAL_NAV, step: 'autosensSettings' };
    expect(walk(start, 2).step).toBe('smbSettings');
    expect(walk(start, 2, { ...ctx, reportsRewindEvents: true })).toMatchObject({ step: 'autosensSettings', autosens: 2 });
  });

  test('SMB Always skips the redundant enable-SMB substeps in both directions', () => {
    const c = { ...ctx, enableSMBAlways: true };
    const jumped = nextNav({ ...INITIAL_NAV, step: 'smbSettings', smb: 0 }, c);
    expect(jumped.smb).toBe(5);
    expect(backNav(jumped, c).smb).toBe(0);
  });

  test('progress bar has 13 segments and partial fill for substeps', () => {
    expect(PROGRESS_STEPS).toHaveLength(13);
    expect(segmentFill('deliveryLimits', { ...INITIAL_NAV, step: 'deliveryLimits', delivery: 1 }, ctx)).toBeCloseTo(2 / 5);
    expect(segmentFill('bluetooth', { ...INITIAL_NAV, step: 'completed' }, ctx)).toBe(1);
  });
});

describe('settings mapping', () => {
  test('writes profile, limits and oref settings', () => {
    const draft = {
      ...DEFAULT_DRAFT,
      targets: [newItem(0, 110)],
      basal: [newItem(0, 0.8), newItem(6 * 3600, 1)],
      carbRatios: [newItem(0, 10)],
      isf: [newItem(0, 50)],
      maxIOB: 5,
      maxBolus: 8,
      maxBasal: 3,
      enableUAM: true,
    };
    const r = buildSettings(draft, { profile: DEFAULT_PROFILE, limits: DEFAULT_LIMITS, orefSettings: { smbInterval: 3 } });
    expect(r.profile.basal).toEqual([
      { startMinute: 0, value: 0.8 },
      { startMinute: 360, value: 1 },
    ]);
    expect(r.profile.target).toEqual([{ startMinute: 0, value: { low: 110, high: 110 } }]);
    expect(r.profile.diaHours).toBe(10);
    expect(r.limits).toMatchObject({ maxIOB: 5, maxBolus: 8, maxBasalRate: 3 });
    expect(r.limits.suspendThreshold).toBe(DEFAULT_LIMITS.suspendThreshold);
    expect(r.orefSettings).toMatchObject({ smbInterval: 3, enableUAM: true, enableSMBWithCOB: false, thresholdSetting: 60, autosensMin: 0.7, maxCOB: 120 });
  });
});

describe('nightscout', () => {
  test('url must be https; trailing slash removed', () => {
    expect(normalizeNightscoutUrl('https://ns.example.org/')).toBe('https://ns.example.org');
    expect(normalizeNightscoutUrl('http://ns.example.org')).toBeNull();
  });

  const profile = (units: string, overrides: Record<string, unknown> = {}) => [
    {
      defaultProfile: 'Default',
      store: {
        Default: {
          units,
          dia: 6,
          basal: [{ time: '00:00', value: 0.83 }],
          carbratio: [{ time: '00:00', value: 12 }],
          sens: [{ time: '00:00', value: units === 'mmol' ? 2.8 : 50 }],
          target_low: [{ time: '00:00', value: units === 'mmol' ? 5.5 : 100 }],
          target_high: [{ time: '00:00', value: units === 'mmol' ? 5.5 : 100 }],
          ...overrides,
        },
      },
    },
  ];

  test('imports and snaps onto the onboarding grids', () => {
    const r = importTherapy(profile('mg/dl'), PUMP_MODELS[0]!);
    expect(r.units).toBe('mg/dL');
    expect(r.basal[0]!.value).toBe(0.85);
    expect(r.isf[0]!.value).toBe(50);
    expect(r.targets[0]!.value).toBe(100);
  });

  test('mmol/L profiles switch units and keep mg/dL values', () => {
    const r = importTherapy(profile('mmol'), PUMP_MODELS[0]!);
    expect(r.units).toBe('mmol/L');
    expect(Math.abs(r.isf[0]!.value - 50)).toBeLessThan(1);
  });

  test('rejects invalid schedules like Trio', () => {
    expect(() => importTherapy(profile('mg/dl', { basal: [{ time: '00:00', value: 0 }] }), PUMP_MODELS[0]!)).toThrow(/basal rates/);
    expect(() => importTherapy(profile('mg/dl', { carbratio: [{ time: '00:00', value: 0 }] }), PUMP_MODELS[0]!)).toThrow(/Carb Ratio/);
  });
});

describe('onboarding never saves an empty therapy schedule', () => {
  test('keeps the existing schedule when the user removed every entry', () => {
    // Arrange: the user deleted all basal and ISF entries before finishing.
    const draft = { ...DEFAULT_DRAFT, basal: [], isf: [], carbRatios: [], targets: [] };

    // Act
    const r = buildSettings(draft, { profile: DEFAULT_PROFILE, limits: DEFAULT_LIMITS, orefSettings: {} });

    // Assert: the loop needs non-empty schedules, so the previous ones stay.
    expect(r.profile.basal).toEqual(DEFAULT_PROFILE.basal);
    expect(r.profile.isf).toEqual(DEFAULT_PROFILE.isf);
    expect(r.profile.carbRatio).toEqual(DEFAULT_PROFILE.carbRatio);
    expect(r.profile.target).toEqual(DEFAULT_PROFILE.target);
  });

  test('blocks Next on a therapy step whose schedule is empty', () => {
    expect(scheduleStepIncomplete('basalRates', { ...DEFAULT_DRAFT, basal: [] })).toBe(true);
    expect(scheduleStepIncomplete('basalRates', DEFAULT_DRAFT)).toBe(DEFAULT_DRAFT.basal.length === 0);
    expect(scheduleStepIncomplete('welcome', { ...DEFAULT_DRAFT, basal: [] })).toBe(false);
  });
});
