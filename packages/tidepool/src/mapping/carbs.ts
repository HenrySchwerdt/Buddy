import type { CarbEntry } from '@buddy/core';
import { isoTime, round } from '../encoding';
import type { FoodDatum, MappedDatum } from '../types';
import { datumId, isExcluded, originOf, resolvedRecordId, type MappingContext } from './context';

/** Fat and protein as Buddy's Nightscout upload carries them. */
export interface CarbMacros {
  readonly fat?: number;
  readonly protein?: number;
}

export type CarbInput = CarbEntry & CarbMacros;

const positive = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n > 0;

/** `origin.id` / selector of a carb entry (carbs, like glucose, are not typed). */
export const carbResolvedId = (ctx: MappingContext, carbId: string): string => resolvedRecordId(ctx, carbId);

/**
 * Trio (`SyncCarbObject`): a `food` datum at the entry time with the grams as net carbohydrate,
 * the absorption time in seconds and the note as the food name.
 */
export function mapCarb(c: CarbInput, ctx: MappingContext): MappedDatum<FoodDatum> | null {
  if (!positive(c.grams) || !Number.isFinite(c.date) || isExcluded(ctx, c.id)) return null;
  const resolved = carbResolvedId(ctx, c.id);
  const name = c.note?.trim();
  return {
    revisedAt: c.date,
    datum: {
      type: 'food',
      time: isoTime(c.date),
      id: datumId(ctx, resolved),
      origin: originOf(ctx, resolved),
      ...(name ? { name } : {}),
      nutrition: {
        carbohydrate: { net: round(c.grams, 3), units: 'grams' },
        ...(positive(c.fat) ? { fat: { total: round(c.fat, 3), units: 'grams' as const } } : {}),
        ...(positive(c.protein) ? { protein: { total: round(c.protein, 3), units: 'grams' as const } } : {}),
        ...(positive(c.absorptionHours) ? { estimatedAbsorptionDuration: Math.round(c.absorptionHours * 3600) } : {}),
      },
      payload: { syncIdentifier: c.id },
    },
  };
}

export const mapCarbs = (carbs: readonly CarbInput[], ctx: MappingContext): MappedDatum<FoodDatum>[] =>
  carbs.flatMap((c) => {
    const m = mapCarb(c, ctx);
    return m ? [m] : [];
  });
