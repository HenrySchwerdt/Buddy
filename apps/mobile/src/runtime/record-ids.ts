import type { Millis } from '@buddy/core';

/**
 * Glucose readings have no id of their own: the store keys them by `source` + `date`, Nightscout, Health and Tidepool
 * by `<source>-<date>`. Callers may pass either the bare source or that full identifier.
 */
export const glucoseIdentifier = (source: string, date: Millis): string => `${source}-${Math.round(date)}`;

export function glucoseSource(id: string, date: Millis): string {
  const suffix = `-${Math.round(date)}`;
  if (id.endsWith(suffix)) return id.slice(0, -suffix.length);
  const colon = `:${Math.round(date)}`;
  if (id.endsWith(colon)) return id.slice(0, -colon.length);
  return id;
}
