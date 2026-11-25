/**
 * TypeScript port of the date helpers in Common/Data.swift (`addDate(at:date:utc:)`,
 * `date(at:_:)`) from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit authors).
 *
 * `Calendar.current` / `TimeZone.current` map to the JavaScript host time zone.
 */
import type { Bytes, Millis } from '@buddy/core';

/**
 * Writes year-2000, month, day, hour, minute, second at `index`. With `utc` the UTC components
 * are written, otherwise the local (device time zone) components — which is what Swift's
 * "shift by the zone delta, then read UTC components" amounts to.
 */
export function writeDate(target: Uint8Array, index: number, date: Millis, utc = true): void {
  const d = new Date(date);
  const c = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  target[index] = (c[0]! - 2000) & 0xff;
  for (let i = 1; i < 6; i++) target[index + i] = c[i]! & 0xff;
}

/** Reads the 6-byte date at `index`, interpreted in UTC or in the local time zone. */
export function readDate(data: Bytes, index: number, usingUtc: boolean): Millis {
  const year = 2000 + (data[index] ?? 0);
  const month = data[index + 1] ?? 1;
  const day = data[index + 2] ?? 1;
  const hour = data[index + 3] ?? 0;
  const min = data[index + 4] ?? 0;
  const sec = data[index + 5] ?? 0;
  return usingUtc ? Date.UTC(year, month - 1, day, hour, min, sec) : new Date(year, month - 1, day, hour, min, sec).getTime();
}
