import { describe, expect, it } from 'vitest';
import { validateBolusSafety, type ActiveOverride, type OverridePreset, type TempTargetPreset } from '@buddy/core';
import { buildShortcutUrl, parseShortcutParams } from '../shortcuts-link';
import { prepareShortcut, type ShortcutContext } from '../shortcuts-prepare';
import { dynamicShortcuts } from '../shortcuts-state';

const NOW = 1_700_000_000_000;

const OVERRIDES: readonly OverridePreset[] = [{ id: 'o1', name: 'Exercise', percentage: 70, target: 150, scaleIsf: true, scaleCr: false, disableSmb: false, durationMin: 60 }];
const TARGETS: readonly TempTargetPreset[] = [{ id: 't1', name: 'Eating Soon', target: 80, durationMin: 60 }];

const ctx = (o: Partial<ShortcutContext> = {}): ShortcutContext => ({
  now: NOW,
  allowBolusByShortcuts: true,
  hasPump: true,
  maxBolus: 10,
  maxCarbs: 250,
  maxFat: 250,
  maxProtein: 250,
  checkBolus: (units) => validateBolusSafety({ units, maxBolus: 10, maxIOB: 8, currentIOB: 1, recentBoluses: [], now: NOW, source: 'app' }),
  mealPresets: [{ dish: 'Pizza', carbs: 60, fat: 20, protein: 15 }],
  overridePresets: OVERRIDES,
  tempTargetPresets: TARGETS,
  activeOverride: null,
  activeTempTarget: null,
  formatTarget: (mgdl) => `${mgdl} mg/dL`,
  ...o,
});

const parse = (q: Record<string, string>) => parseShortcutParams(q);

describe('parseShortcutParams', () => {
  it('parses a bolus with comma decimals', () => {
    expect(parse({ action: 'bolus', units: '1,5' })).toEqual({ ok: true, action: { kind: 'bolus', units: 1.5 } });
  });

  it.each([
    ['missing', {}],
    ['zero', { units: '0' }],
    ['negative', { units: '-1' }],
    ['non numeric', { units: 'abc' }],
    ['exponent', { units: '1e3' }],
    ['infinity', { units: 'Infinity' }],
    ['huge', { units: '500' }],
  ])('rejects a bolus with %s units', (_, extra) => {
    expect(parse({ action: 'bolus', ...(extra as Record<string, string>) }).ok).toBe(false);
  });

  it('rejects unknown and missing actions', () => {
    expect(parse({ action: 'wipe' }).ok).toBe(false);
    expect(parse({}).ok).toBe(false);
  });

  it('parses carbs with fat, protein and a trimmed note', () => {
    expect(parse({ action: 'carbs', grams: '30', fat: '5', protein: '2', note: ' lunch ' })).toEqual({ ok: true, action: { kind: 'carbs', grams: 30, fat: 5, protein: 2, note: 'lunch' } });
    expect(parse({ action: 'carbs', grams: '0' }).ok).toBe(false);
    expect(parse({ action: 'carbs', grams: '30', fat: 'x' }).ok).toBe(false);
  });

  it('requires a preset name for preset actions', () => {
    expect(parse({ action: 'override-apply' }).ok).toBe(false);
    expect(parse({ action: 'override-apply', name: 'Exercise' })).toEqual({ ok: true, action: { kind: 'overrideApply', name: 'Exercise' } });
    expect(parse({ action: 'override-cancel' }).ok).toBe(true);
  });

  it('round-trips through buildShortcutUrl', () => {
    const actions = [
      { kind: 'bolus', units: 2.5 },
      { kind: 'carbs', grams: 40, fat: 3, protein: 0, note: 'a & b=c+d' },
      { kind: 'tempTargetApply', name: 'Eating Soon' },
      { kind: 'overrideCancel' },
      { kind: 'state' },
    ] as const;
    for (const a of actions) {
      const url = new URL(buildShortcutUrl(a));
      expect(url.protocol).toBe('buddy:');
      expect(parse(Object.fromEntries(url.searchParams))).toEqual({ ok: true, action: a });
    }
  });
});

describe('prepareShortcut: bolus', () => {
  const bolus = (units: number, c = ctx()) => prepareShortcut({ kind: 'bolus', units }, c);

  it('asks for confirmation and marks insulin delivery', () => {
    const p = bolus(2);
    expect(p.ok && p.insulin && p.needsConfirmation && p.plan).toEqual({ type: 'bolus', units: 2 });
  });

  it('is refused when bolusing by shortcuts is off', () => {
    const p = bolus(2, ctx({ allowBolusByShortcuts: false }));
    expect(p.ok).toBe(false);
  });

  it('is refused without a pump', () => {
    expect(bolus(2, ctx({ hasPump: false })).ok).toBe(false);
  });

  it('applies the Trio safety checks with the app wording', () => {
    const over = bolus(11);
    expect(over).toMatchObject({ ok: false, error: expect.stringContaining('max bolus') });
    const iob = bolus(5, ctx({ checkBolus: (units) => validateBolusSafety({ units, maxBolus: 10, maxIOB: 8, currentIOB: 4, recentBoluses: [], now: NOW, source: 'app' }) }));
    expect(iob).toMatchObject({ ok: false, error: expect.stringContaining('max IOB') });
    const recent = bolus(2, ctx({ checkBolus: (units) => validateBolusSafety({ units, maxBolus: 10, maxIOB: 8, currentIOB: 1, recentBoluses: [{ date: NOW - 60_000, units: 2 }], now: NOW, source: 'app' }) }));
    expect(recent).toMatchObject({ ok: false, error: expect.stringContaining('last 6 minutes') });
  });
});

describe('prepareShortcut: carbs and presets', () => {
  it('limits carbs to the Meal Settings maximum', () => {
    expect(prepareShortcut({ kind: 'carbs', grams: 260, fat: 0, protein: 0, note: '' }, ctx()).ok).toBe(false);
    expect(prepareShortcut({ kind: 'carbs', grams: 30, fat: 0, protein: 0, note: '' }, ctx())).toMatchObject({ ok: true, insulin: false, needsConfirmation: true });
  });

  it('finds a meal preset ignoring case and reports unknown names', () => {
    expect(prepareShortcut({ kind: 'carbPreset', name: ' pizza ' }, ctx())).toMatchObject({ ok: true, plan: { type: 'carbs', grams: 60, fat: 20, protein: 15 } });
    expect(prepareShortcut({ kind: 'carbPreset', name: 'Soup' }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining('Pizza') });
  });
});

describe('prepareShortcut: overrides and temp targets', () => {
  const preset: OverridePreset = OVERRIDES[0]!;

  it('always asks before starting a preset', () => {
    const p = prepareShortcut({ kind: 'overrideApply', name: preset.name }, ctx());
    expect(p).toMatchObject({ ok: true, needsConfirmation: true, insulin: false, plan: { type: 'overrideApply' } });
    const t = prepareShortcut({ kind: 'tempTargetApply', name: TARGETS[0]!.name }, ctx());
    expect(t).toMatchObject({ ok: true, needsConfirmation: true, plan: { type: 'tempTargetApply' } });
  });

  it('refuses ambiguous preset names', () => {
    const twice = [preset, { ...preset, id: 'other' }];
    expect(prepareShortcut({ kind: 'overrideApply', name: preset.name }, ctx({ overridePresets: twice })).ok).toBe(false);
  });

  it('cancel needs something running', () => {
    expect(prepareShortcut({ kind: 'overrideCancel' }, ctx()).ok).toBe(false);
    const running: ActiveOverride = { ...preset, startedAt: NOW - 60_000 };
    expect(prepareShortcut({ kind: 'overrideCancel' }, ctx({ activeOverride: running }))).toMatchObject({ ok: true, plan: { type: 'overrideCancel' } });
    expect(prepareShortcut({ kind: 'tempTargetCancel' }, ctx()).ok).toBe(false);
  });

  it('state needs no confirmation and no data', () => {
    expect(prepareShortcut({ kind: 'state' }, ctx())).toMatchObject({ ok: true, needsConfirmation: false, plan: { type: 'state' } });
  });
});

describe('dynamicShortcuts', () => {
  it('builds confirmation deep links with encoded names', () => {
    const list = dynamicShortcuts([{ ...OVERRIDES[0]!, id: 'a', name: 'Run & Jump' }], []);
    expect(list).toHaveLength(1);
    const url = new URL(list[0]!.url);
    expect(url.searchParams.get('action')).toBe('override-apply');
    expect(url.searchParams.get('name')).toBe('Run & Jump');
  });
});
