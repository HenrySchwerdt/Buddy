import type { GlucoseUnit } from '@buddy/core';
import { fmtGlucoseValue } from './picker';

/** Trio → Buddy branding for ported copy. */
export const brand = (s: string) => s.replace(/\bTrio\b/g, 'Buddy');

/** Resolves `{g:N}` (N mg/dL in the user's unit) and `{unit}` tokens, then rebrands. */
export function resolveCopy(s: string, units: GlucoseUnit): string {
  return brand(s.replace(/\{g:([0-9.]+)\}/g, (_, n: string) => fmtGlucoseValue(Number(n), units)).replace(/\{unit\}/g, units));
}

export type HintLineStyle = 'plain' | 'bold' | 'warning';

/** Splits a hint line into its style prefix ("**" bold, "!!" warning) and text. */
export function parseHintLine(line: string): { style: HintLineStyle; text: string } {
  if (line.startsWith('**')) return { style: 'bold', text: line.slice(2) };
  if (line.startsWith('!!')) return { style: 'warning', text: line.slice(2) };
  return { style: 'plain', text: line };
}
