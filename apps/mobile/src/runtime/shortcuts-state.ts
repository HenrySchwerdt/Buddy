import type { OverridePreset, TempTargetPreset } from '@buddy/core';
import type { StatusContent } from './live-activity-content';
import { buildShortcutUrl } from './shortcuts-link';

/** Snapshot handed to the iOS App Intents (Get State, bolus switch, preset names) and shown by the in-app state screen. */
export interface ShortcutState {
  readonly glucose: string;
  readonly unit: string;
  readonly arrow: string;
  readonly delta: string;
  /** Epoch seconds of the reading; 0 = none. */
  readonly readingAt: number;
  readonly iob: string;
  readonly cob: string;
  readonly allowBolus: boolean;
  readonly override: string | null;
  readonly tempTarget: string | null;
  readonly overridePresets: readonly string[];
  readonly tempTargetPresets: readonly string[];
  readonly mealPresets: readonly string[];
  /** Epoch seconds. */
  readonly updatedAt: number;
}

export interface ShortcutStateInput {
  readonly status: StatusContent;
  readonly allowBolus: boolean;
  readonly override: string | null;
  readonly tempTarget: string | null;
  readonly overridePresets: readonly OverridePreset[];
  readonly tempTargetPresets: readonly TempTargetPreset[];
  readonly mealPresets: readonly { readonly dish: string }[];
  readonly now: number;
}

export function buildShortcutState(i: ShortcutStateInput): ShortcutState {
  const s = i.status;
  return {
    glucose: s.glucose,
    unit: s.unit,
    arrow: s.arrow,
    delta: s.delta,
    readingAt: s.readingAt,
    iob: s.iob,
    cob: s.cob,
    allowBolus: i.allowBolus,
    override: i.override,
    tempTarget: i.tempTarget,
    overridePresets: i.overridePresets.map((p) => p.name),
    tempTargetPresets: i.tempTargetPresets.map((p) => p.name),
    mealPresets: i.mealPresets.map((p) => p.dish),
    updatedAt: Math.floor(i.now / 1000),
  };
}

const clock = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Text lines for the state screen (same facts Trio's "List State" intent returns). */
export function describeState(s: ShortcutState): string[] {
  return [
    s.readingAt === 0 ? 'Glucose: no reading' : `Glucose: ${s.glucose} ${s.unit}${s.arrow ? ` ${s.arrow}` : ''}${s.delta ? ` (${s.delta})` : ''} at ${clock(s.readingAt)}`,
    `IOB: ${s.iob} U`,
    `COB: ${s.cob} g`,
    `Override: ${s.override ?? 'none'}`,
    `Temp target: ${s.tempTarget ?? 'none'}`,
  ];
}

export interface DynamicShortcut {
  readonly id: string;
  readonly shortLabel: string;
  readonly longLabel: string;
  readonly url: string;
}

/** Android launcher shortcuts for the saved override and temp target presets (confirmation still happens in the app). */
export function dynamicShortcuts(overrides: readonly OverridePreset[], targets: readonly TempTargetPreset[]): DynamicShortcut[] {
  const short = (s: string) => (s.length > 14 ? `${s.slice(0, 13)}…` : s);
  return [
    ...overrides.map((p) => ({ id: `override-${p.id}`, shortLabel: short(p.name), longLabel: `Start override ${p.name}`, url: buildShortcutUrl({ kind: 'overrideApply', name: p.name }) })),
    ...targets.map((p) => ({ id: `target-${p.id}`, shortLabel: short(p.name), longLabel: `Start temp target ${p.name}`, url: buildShortcutUrl({ kind: 'tempTargetApply', name: p.name }) })),
  ];
}
