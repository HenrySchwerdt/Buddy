/** Trio's basal formatter: 2–3 fraction digits ("0.10", "0.125"). */
export function fmtBasal(v: number): string {
  const s = v.toFixed(3);
  return s.endsWith('0') ? v.toFixed(2) : s;
}

/** Port of BasalProfileEditor.StateModel.calcTotal: U/day of a 24 h step schedule. */
export function basalTotal(items: readonly { minute: number; value: number }[]): number {
  return items.reduce((sum, item, i) => sum + item.value * (((items[i + 1]?.minute ?? 24 * 60) - item.minute) / 60), 0);
}
