import { toMmol, type GlucoseUnit } from '@buddy/core';

/**
 * Splits oref's `reason` into the tag cloud ("ISF: 50→45", "COB: 0", ...) and the conclusion that
 * follows the first semicolon (Trio: OrefDetermination.reasonParts / reasonConclusion).
 */
export function parseReason(reason: string): { tags: string[]; conclusion: string } {
  const text = reason.trim();
  if (text === '') return { tags: [], conclusion: '' };
  const cut = text.indexOf(';');
  const head = cut === -1 ? text : text.slice(0, cut);
  const conclusion = cut === -1 ? '' : text.slice(cut + 1).trim();
  // A tag-less reason (an error message, say) is all conclusion.
  if (!/:|\bminPredBG|\bminGuardBG|predBG/.test(head)) return { tags: [], conclusion: text };
  return { tags: head.split(/,\s*(?![^()]*\))/).map((t) => t.trim()).filter(Boolean), conclusion };
}

const mmol = (v: string): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(toMmol(n) * 10) / 10) : v;
};

/** Tags whose numbers are glucose (or glucose per unit) and so follow the display unit. */
const GLUCOSE_TAGS = /^(ISF|Target|minPredBG|minGuardBG|IOBpredBG|COBpredBG|UAMpredBG|Dev|BGI)\b/;

/** Converts the glucose numbers of one tag to mmol/L ("ISF: 50→45" → "ISF: 2.8→2.5"). */
export function convertTag(tag: string, units: GlucoseUnit): string {
  if (units === 'mg/dL' || !GLUCOSE_TAGS.test(tag)) return tag;
  return tag.replace(/-?\d+(?:\.\d+)?/g, mmol);
}

/** Converts the glucose values in the conclusion ("Eventual BG 100 >= 100", "minGuardBG 90<100"). */
export function convertConclusion(conclusion: string, units: GlucoseUnit): string {
  if (units === 'mg/dL') return capitalize(conclusion);
  const num = '(-?\\d+\\.?\\d*)';
  const out = conclusion
    .replace(new RegExp(`(minGuardBG\\s*)${num}(\\s*<\\s*)${num}`, 'g'), (_m, a, x, b, y) => `${a}${mmol(x)}${b}${mmol(y)}`)
    .replace(new RegExp(`(Eventual BG\\s*)${num}(\\s*(?:>=|<)\\s*)${num}`, 'g'), (_m, a, x, b, y) => `${a}${mmol(x)}${b}${mmol(y)}`)
    .replace(new RegExp(`(\\S+\\s+)${num}(\\s*>\\s*\\d+%\\s+of\\s+BG\\s+)${num}`, 'g'), (_m, a, x, b, y) => `${a}${mmol(x)}${b}${mmol(y)}`);
  return capitalize(out);
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The "Latest Raw Algorithm Output" tags: oref's reason parts plus TDD when known. */
export function computedTags(reason: string, tdd: number | undefined, units: GlucoseUnit): string[] {
  const tags = parseReason(reason).tags.map((t) => convertTag(t, units));
  if (tdd !== undefined && tdd !== 0 && !tags.some((t) => t.startsWith('TDD'))) tags.push(`TDD: ${Math.round(tdd * 10) / 10}`);
  return tags;
}
