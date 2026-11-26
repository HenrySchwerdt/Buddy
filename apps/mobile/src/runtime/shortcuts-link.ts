/**
 * Deep-link grammar for Shortcuts / App Intents / Android App Shortcuts (Trio `Shortcuts/*`).
 *
 *   buddy://shortcut?action=bolus&units=1.5
 *   buddy://shortcut?action=carbs&grams=30[&fat=10][&protein=5][&note=Pasta]
 *   buddy://shortcut?action=carb-preset&name=Pizza
 *   buddy://shortcut?action=override-apply&name=Exercise     buddy://shortcut?action=override-cancel
 *   buddy://shortcut?action=temp-target-apply&name=Eating    buddy://shortcut?action=temp-target-cancel
 *   buddy://shortcut?action=state                            buddy://shortcut?action=restart-live-activity
 *
 * Pure parsing only. A link never acts by itself: the in-app confirmation screen (app/shortcut.tsx)
 * shows the prepared action and only its Confirm button executes it.
 */

export type ShortcutAction =
  | { readonly kind: 'bolus'; readonly units: number }
  | { readonly kind: 'carbs'; readonly grams: number; readonly fat: number; readonly protein: number; readonly note: string }
  | { readonly kind: 'carbPreset'; readonly name: string }
  | { readonly kind: 'overrideApply'; readonly name: string }
  | { readonly kind: 'overrideCancel' }
  | { readonly kind: 'tempTargetApply'; readonly name: string }
  | { readonly kind: 'tempTargetCancel' }
  | { readonly kind: 'state' }
  | { readonly kind: 'restartLiveActivity' };

export type ShortcutKind = ShortcutAction['kind'];

export type ParsedShortcut = { readonly ok: true; readonly action: ShortcutAction } | { readonly ok: false; readonly error: string };

export const SHORTCUT_SCHEME = 'buddy';
export const SHORTCUT_PATH = 'shortcut';

/** Hard upper bounds on what a link may even ask for; the real limits are checked again in `prepareShortcut`. */
export const LINK_MAX_UNITS = 200;
export const LINK_MAX_GRAMS = 300;
const MAX_NAME = 80;
const MAX_NOTE = 200;

const ACTION_NAMES: Readonly<Record<string, ShortcutKind>> = {
  bolus: 'bolus',
  carbs: 'carbs',
  'carb-preset': 'carbPreset',
  'override-apply': 'overrideApply',
  'override-cancel': 'overrideCancel',
  'temp-target-apply': 'tempTargetApply',
  'temp-target-cancel': 'tempTargetCancel',
  state: 'state',
  'restart-live-activity': 'restartLiveActivity',
};

const LINK_NAMES: Readonly<Record<ShortcutKind, string>> = Object.fromEntries(Object.entries(ACTION_NAMES).map(([link, kind]) => [kind, link])) as Record<ShortcutKind, string>;

export type LinkParams = Readonly<Record<string, string | readonly string[] | undefined>>;

const first = (v: string | readonly string[] | undefined): string | undefined => (typeof v === 'string' ? v : v?.[0]);

/** Accepts "1.5" and "1,5"; anything else (NaN, Infinity, "1e3x") is undefined. */
function number(v: string | readonly string[] | undefined): number | undefined {
  const s = first(v)?.trim().replace(',', '.');
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const text = (v: string | readonly string[] | undefined, max: number): string => (first(v) ?? '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, max);

export function parseShortcutParams(params: LinkParams): ParsedShortcut {
  const name = first(params.action)?.trim().toLowerCase();
  const kind = name ? ACTION_NAMES[name] : undefined;
  if (!kind) return { ok: false, error: name ? `Unknown action "${name.slice(0, 40)}".` : 'No action given.' };
  switch (kind) {
    case 'bolus': {
      const units = number(params.units);
      if (units === undefined || units <= 0) return { ok: false, error: 'The bolus amount is missing or invalid.' };
      if (units > LINK_MAX_UNITS) return { ok: false, error: 'The bolus amount is out of range.' };
      return { ok: true, action: { kind, units } };
    }
    case 'carbs': {
      const grams = number(params.grams);
      const fat = params.fat === undefined ? 0 : number(params.fat);
      const protein = params.protein === undefined ? 0 : number(params.protein);
      if (grams === undefined || grams <= 0 || grams > LINK_MAX_GRAMS) return { ok: false, error: 'The carbs amount is missing or invalid.' };
      if (fat === undefined || protein === undefined || fat > LINK_MAX_GRAMS || protein > LINK_MAX_GRAMS) return { ok: false, error: 'The fat or protein amount is invalid.' };
      return { ok: true, action: { kind, grams, fat, protein, note: text(params.note, MAX_NOTE) } };
    }
    case 'carbPreset':
    case 'overrideApply':
    case 'tempTargetApply': {
      const preset = text(params.name, MAX_NAME);
      return preset ? { ok: true, action: { kind, name: preset } } : { ok: false, error: 'The preset name is missing.' };
    }
    case 'overrideCancel':
    case 'tempTargetCancel':
    case 'state':
    case 'restartLiveActivity':
      return { ok: true, action: { kind } };
  }
}

/** The custom-scheme URL for an action (used by Android shortcuts and tests; iOS intents build the same strings in Swift). */
export function buildShortcutUrl(action: ShortcutAction): string {
  const q: [string, string][] = [['action', LINK_NAMES[action.kind]]];
  switch (action.kind) {
    case 'bolus':
      q.push(['units', String(action.units)]);
      break;
    case 'carbs':
      q.push(['grams', String(action.grams)]);
      if (action.fat) q.push(['fat', String(action.fat)]);
      if (action.protein) q.push(['protein', String(action.protein)]);
      if (action.note) q.push(['note', action.note]);
      break;
    case 'carbPreset':
    case 'overrideApply':
    case 'tempTargetApply':
      q.push(['name', action.name]);
      break;
    default:
      break;
  }
  return `${SHORTCUT_SCHEME}://${SHORTCUT_PATH}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}
