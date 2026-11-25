/** Small helpers shared by the SVG stat charts. */

/** "Nice" axis ticks within [min, max], aiming for 3–5 lines like Swift Charts' automatic marks. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= target + 0.5) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Contiguous runs of indices where `ok(i)` holds (used to break areas/lines at gaps). */
export function runs(count: number, ok: (i: number) => boolean): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < count; i++) {
    if (ok(i)) cur.push(i);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
