import { isOverrideActive, isTempTargetActive, type ActiveOverride, type ActiveTempTarget, type BolusSafetyResult, type OverridePreset, type TempTargetPreset } from '@buddy/core';
import type { ShortcutAction } from './shortcuts-link';

/**
 * Turns a parsed shortcut into what the confirmation screen shows, or into a refusal. Pure: the caller
 * passes everything it needs. Nothing here changes state; execution is `executeShortcut` (shortcuts.ts),
 * and only the confirmation screen's button calls it.
 */

export interface MealPresetLike {
  readonly dish: string;
  readonly carbs: number;
  readonly fat: number;
  readonly protein: number;
}

export interface ShortcutContext {
  readonly now: number;
  readonly allowBolusByShortcuts: boolean;
  readonly hasPump: boolean;
  readonly maxBolus: number;
  readonly maxCarbs: number;
  readonly maxFat: number;
  readonly maxProtein: number;
  /** Runs `checkBolusSafety` (max bolus, IOB availability, max IOB, recent boluses) for the requested units. */
  readonly checkBolus: (units: number) => BolusSafetyResult;
  readonly mealPresets: readonly MealPresetLike[];
  readonly overridePresets: readonly OverridePreset[];
  readonly tempTargetPresets: readonly TempTargetPreset[];
  readonly activeOverride: ActiveOverride | null;
  readonly activeTempTarget: ActiveTempTarget | null;
  /** "mg/dL" or "mmol/L" formatting of a target in mg/dL. */
  readonly formatTarget: (mgdl: number) => string;
}

export type ExecutionPlan =
  | { readonly type: 'bolus'; readonly units: number }
  | { readonly type: 'carbs'; readonly grams: number; readonly fat: number; readonly protein: number; readonly note: string }
  | { readonly type: 'overrideApply'; readonly preset: OverridePreset }
  | { readonly type: 'overrideCancel' }
  | { readonly type: 'tempTargetApply'; readonly preset: TempTargetPreset }
  | { readonly type: 'tempTargetCancel' }
  | { readonly type: 'state' }
  | { readonly type: 'restartLiveActivity' };

export type PreparedShortcut =
  | {
      readonly ok: true;
      readonly title: string;
      readonly lines: readonly string[];
      readonly confirmLabel: string;
      /** True when confirming delivers insulin. */
      readonly insulin: boolean;
      /** The read-only state action needs no confirmation. */
      readonly needsConfirmation: boolean;
      readonly plan: ExecutionPlan;
    }
  | { readonly ok: false; readonly title: string; readonly error: string };

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

const refuse = (title: string, error: string): PreparedShortcut => ({ ok: false, title, error });

const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

function findPreset<T>(items: readonly T[], name: string, label: (t: T) => string, what: string, title: string): { item: T } | { refusal: PreparedShortcut } {
  const matches = items.filter((i) => same(label(i), name));
  if (matches.length === 1) return { item: matches[0]! };
  if (matches.length > 1) return { refusal: refuse(title, `More than one ${what} is called "${name}". Rename one of them.`) };
  const available = items.map(label).slice(0, 8).join(', ');
  return { refusal: refuse(title, `No ${what} called "${name}"${available ? ` (available: ${available})` : ' (none saved)'}.`) };
}

const durationText = (min: number | null) => (min === null ? 'until cancelled' : min >= 60 ? `${fmt(min / 60)} h` : `${min} min`);

export function prepareShortcut(action: ShortcutAction, ctx: ShortcutContext): PreparedShortcut {
  switch (action.kind) {
    case 'bolus': {
      const title = 'Bolus';
      if (!ctx.allowBolusByShortcuts) return refuse(title, 'Bolus by Shortcuts is switched off. Turn it on under Settings → Features → Shortcuts.');
      if (!ctx.hasPump) return refuse(title, 'No pump is connected.');
      const safety = ctx.checkBolus(action.units);
      if (!safety.ok) return refuse(title, safety.message);
      return {
        ok: true,
        title,
        lines: [`${fmt(action.units)} U of insulin will be delivered by the pump.`, `Pump max bolus: ${fmt(ctx.maxBolus)} U.`],
        confirmLabel: `Deliver ${fmt(action.units)} U`,
        insulin: true,
        needsConfirmation: true,
        plan: { type: 'bolus', units: action.units },
      };
    }
    case 'carbs': {
      const title = 'Add Carbs';
      if (action.grams > ctx.maxCarbs) return refuse(title, `Carbs are limited to ${fmt(ctx.maxCarbs)} g.`);
      if (action.fat > ctx.maxFat || action.protein > ctx.maxProtein) return refuse(title, 'Fat or protein is above the limit set under Meal Settings.');
      return carbsPrepared(title, action.grams, action.fat, action.protein, action.note);
    }
    case 'carbPreset': {
      const title = 'Add Meal Preset';
      const found = findPreset(ctx.mealPresets, action.name, (p) => p.dish, 'meal preset', title);
      if ('refusal' in found) return found.refusal;
      const p = found.item;
      if (p.carbs > ctx.maxCarbs || p.fat > ctx.maxFat || p.protein > ctx.maxProtein) return refuse(title, 'This preset is above the limits set under Meal Settings.');
      return carbsPrepared(title, p.carbs, p.fat, p.protein, p.dish);
    }
    case 'overrideApply': {
      const title = 'Start Override';
      const found = findPreset(ctx.overridePresets, action.name, (p) => p.name, 'override preset', title);
      if ('refusal' in found) return found.refusal;
      const p = found.item;
      return {
        ok: true,
        title,
        lines: [
          `${p.name}: ${p.percentage}% insulin, ${durationText(p.durationMin)}.`,
          p.target === null ? 'Glucose target: unchanged.' : `Glucose target: ${ctx.formatTarget(p.target)}.`,
          ...(p.disableSmb ? ['SMBs are switched off.'] : []),
          ...(isOverrideActive(ctx.activeOverride, ctx.now) ? [`Replaces the running override "${ctx.activeOverride.name}".`] : []),
          'An override changes how much insulin the loop delivers.',
        ],
        confirmLabel: 'Start Override',
        insulin: false,
        needsConfirmation: true,
        plan: { type: 'overrideApply', preset: p },
      };
    }
    case 'overrideCancel': {
      const title = 'Cancel Override';
      if (!isOverrideActive(ctx.activeOverride, ctx.now)) return refuse(title, 'No override is running.');
      return { ok: true, title, lines: [`"${ctx.activeOverride.name}" will be stopped.`], confirmLabel: 'Cancel Override', insulin: false, needsConfirmation: true, plan: { type: 'overrideCancel' } };
    }
    case 'tempTargetApply': {
      const title = 'Start Temp Target';
      const found = findPreset(ctx.tempTargetPresets, action.name, (p) => p.name, 'temp target preset', title);
      if ('refusal' in found) return found.refusal;
      const p = found.item;
      return {
        ok: true,
        title,
        lines: [
          `${p.name}: ${ctx.formatTarget(p.target)} for ${durationText(p.durationMin)}.`,
          ...(isTempTargetActive(ctx.activeTempTarget, ctx.now) ? [`Replaces the running temp target "${ctx.activeTempTarget.name}".`] : []),
          'A temp target changes how much insulin the loop delivers.',
        ],
        confirmLabel: 'Start Temp Target',
        insulin: false,
        needsConfirmation: true,
        plan: { type: 'tempTargetApply', preset: p },
      };
    }
    case 'tempTargetCancel': {
      const title = 'Cancel Temp Target';
      const t = ctx.activeTempTarget;
      if (!t || !isTempTargetActive(t, ctx.now)) return refuse(title, 'No temp target is running.');
      return { ok: true, title, lines: [`"${t.name}" will be stopped.`], confirmLabel: 'Cancel Temp Target', insulin: false, needsConfirmation: true, plan: { type: 'tempTargetCancel' } };
    }
    case 'state':
      return { ok: true, title: 'Current State', lines: [], confirmLabel: 'Done', insulin: false, needsConfirmation: false, plan: { type: 'state' } };
    case 'restartLiveActivity':
      return { ok: true, title: 'Restart Live Activity', lines: [], confirmLabel: 'Done', insulin: false, needsConfirmation: false, plan: { type: 'restartLiveActivity' } };
  }
}

function carbsPrepared(title: string, grams: number, fat: number, protein: number, note: string): PreparedShortcut {
  const parts = [`${fmt(grams)} g carbs`, ...(fat > 0 ? [`${fmt(fat)} g fat`] : []), ...(protein > 0 ? [`${fmt(protein)} g protein`] : [])];
  return {
    ok: true,
    title,
    lines: [`${parts.join(', ')} will be logged now${note ? ` ("${note}")` : ''}.`, 'In closed loop, logged carbs make the loop deliver more insulin.'],
    confirmLabel: 'Log Carbs',
    insulin: false,
    needsConfirmation: true,
    plan: { type: 'carbs', grams, fat, protein, note },
  };
}
