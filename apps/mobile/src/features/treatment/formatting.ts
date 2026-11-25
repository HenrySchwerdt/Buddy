/**
 * Number formatting and button/warning logic of Trio's Treatments views
 * (`TreatmentsRootView`, `PopupView`, `ForecastChart`). Pure TS.
 */

const EPS = 1e-9;
const MGDL_PER_MMOLL = 18.0182;

export type GlucoseUnits = 'mg/dL' | 'mmol/L';
export type RoundingMode = 'down' | 'plain';

function roundAt(value: number, scale: number, mode: RoundingMode): number {
  const f = 10 ** scale;
  // NSDecimalNumber .down rounds toward −∞, .plain rounds half away from zero.
  const scaled = mode === 'down' ? Math.floor(value * f + EPS) : Math.sign(value) * Math.round(Math.abs(value) * f + EPS);
  return scaled / f || 0;
}

function numberFormat(locale: string | undefined, minFraction: number, maxFraction: number, signAlways = false): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: minFraction, maximumFractionDigits: maxFraction, signDisplay: signAlways ? 'always' : 'auto' });
}

/** PopupView `insulinFormatter`: two fraction digits (three when rounded for pump), `.down` by default. */
export function insulinFormatter(value: number, mode: RoundingMode = 'down', roundedForPump = false, locale?: string): string {
  const scale = roundedForPump ? 3 : 2;
  return numberFormat(locale, 2, scale).format(roundAt(value, scale, mode));
}

/** PopupView `wrapNegative`: negative values in parentheses. */
export function wrapNegative(value: number, mode: RoundingMode = 'down', locale?: string): string {
  const s = insulinFormatter(value, mode, false, locale);
  return value < 0 ? `(${s})` : s;
}

/** TreatmentsRootView `formatter`: up to three fraction digits ("0,2", "1,25"). */
export function bolusAmountFormatter(value: number, locale?: string): string {
  return numberFormat(locale, 0, 3).format(value);
}

/** `Formatter.bolusFormatter`: up to two fraction digits (insulin chip above the chart). */
export function bolusChipFormatter(value: number, locale?: string): string {
  return numberFormat(locale, 0, 2).format(value);
}

/** `Decimal.formatted(for:)` for glucose: mg/dL whole numbers, mmol/L one decimal. */
export function formatGlucoseValue(mgdl: number, units: GlucoseUnits, locale?: string): string {
  return units === 'mg/dL' ? numberFormat(locale, 0, 0).format(Math.round(mgdl)) : numberFormat(locale, 1, 1).format(mgdl / MGDL_PER_MMOLL);
}

/** `formattedISF`: mg/dL with up to one fraction digit, mmol/L one digit. */
export function formatIsf(mgdl: number, units: GlucoseUnits, locale?: string): string {
  return units === 'mg/dL' ? numberFormat(locale, 0, 1).format(mgdl) : numberFormat(locale, 1, 1).format(mgdl / MGDL_PER_MMOLL);
}

/** `formattedDelta`: always signed ("+16", "+0"). */
export function formatGlucoseDelta(mgdl: number, units: GlucoseUnits, locale?: string): string {
  return units === 'mg/dL' ? numberFormat(locale, 0, 0, true).format(Math.round(mgdl)) : numberFormat(locale, 1, 1, true).format(mgdl / MGDL_PER_MMOLL);
}

/** `Decimal.formatted(.wholePercent)` */
export function formatWholePercent(fraction: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
}

/** Parses user input with either decimal separator; empty/invalid → 0. */
export function parseDecimal(text: string): number {
  const n = Number(text.replace(',', '.').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Treatment button ─────────────────────────────────────────────────────────

export interface TreatmentButtonState {
  readonly amount: number;
  readonly carbs: number;
  readonly fat: number;
  readonly protein: number;
  readonly externalInsulin: boolean;
  readonly maxBolus: number;
  readonly maxCarbs: number;
  readonly maxFat: number;
  readonly maxProtein: number;
}

const num = (v: number, locale?: string) => numberFormat(locale, 0, 3).format(v);

/** `maxExternal`: Max Bolus × 3. */
export const maxExternal = (maxBolus: number) => maxBolus * 3;

/** Limit message, or null when nothing is exceeded (Trio checks in this order). */
export function limitExceededLabel(s: TreatmentButtonState, locale?: string): string | null {
  if (!s.externalInsulin && s.amount > s.maxBolus) return `Max Bolus of ${num(s.maxBolus, locale)} U Exceeded`;
  if (s.externalInsulin && s.amount > maxExternal(s.maxBolus)) return `Max External Bolus of ${num(maxExternal(s.maxBolus), locale)} U Exceeded`;
  if (s.carbs > s.maxCarbs) return `Max Carbs of ${num(s.maxCarbs, locale)} g Exceeded`;
  if (s.fat > s.maxFat) return `Max Fat of ${num(s.maxFat, locale)} g Exceeded`;
  if (s.protein > s.maxProtein) return `Max Protein of ${num(s.maxProtein, locale)} g Exceeded`;
  return null;
}

/** `taskButtonLabel` of TreatmentsRootView. */
export function treatmentButtonLabel(s: TreatmentButtonState, locale?: string): string {
  const limit = limitExceededLabel(s, locale);
  if (limit) return limit;
  const hasInsulin = s.amount > 0;
  const hasCarbs = s.carbs > 0;
  const hasFatOrProtein = s.fat > 0 || s.protein > 0;
  const bolusString = s.externalInsulin ? 'External Insulin' : 'Enact Bolus';
  if (hasInsulin && hasCarbs && hasFatOrProtein) return `Log Meal and ${bolusString}`;
  if (hasInsulin && hasCarbs) return `Log Carbs and ${bolusString}`;
  if (hasInsulin && hasFatOrProtein) return `Log FPU and ${bolusString}`;
  if (hasInsulin) return s.externalInsulin ? 'Log External Insulin' : 'Enact Bolus';
  if (hasCarbs && hasFatOrProtein) return 'Log Meal';
  if (hasCarbs) return 'Log Carbs';
  if (hasFatOrProtein) return 'Log FPU';
  return 'Continue Without Treatment';
}

export type WarningTone = 'red' | 'orange';

/** `bolusWarning`: only for a pump bolus with an amount. */
export function bolusWarning(p: { externalInsulin: boolean; amount: number; currentBG: number; minPredBG: number; confirmBolus: boolean }): { shouldConfirm: boolean; message: string; tone: WarningTone } {
  if (p.externalInsulin || !(p.amount > 0)) return { shouldConfirm: false, message: '', tone: 'orange' };
  const veryLow = p.currentBG < 54;
  const forecastLow = p.minPredBG < 54;
  const message = veryLow ? 'Glucose is very low.' : forecastLow ? 'Glucose forecast is very low.' : '';
  return { shouldConfirm: p.confirmBolus && (veryLow || forecastLow), message, tone: veryLow ? 'red' : 'orange' };
}

/** CustomProgressView text while the treatment is processed. */
export function progressText(amount: number, carbs: number): string {
  if (amount > 0 && carbs > 0) return 'Updating IOB and COB ...';
  if (carbs > 0) return 'Updating COB ...';
  if (amount > 0) return 'Updating IOB ...';
  return 'Updating Treatments ...';
}

// ── Recommended bolus card (PopupView) ───────────────────────────────────────

export interface RecommendationCardInput {
  readonly insulinCalculated: number;
  readonly factoredInsulin: number;
  readonly iob: number;
  readonly maxIOB: number;
  readonly maxBolus: number;
  readonly currentBG: number;
  readonly minPredBG: number;
  readonly lastLoopDate: number | null;
  readonly now: number;
}

export type RecommendationWarning =
  | { readonly kind: 'stale' }
  | { readonly kind: 'veryLow' }
  | { readonly kind: 'forecastLow' }
  | { readonly kind: 'maxBolus' }
  | { readonly kind: 'iobAboveMax' }
  | { readonly kind: 'maxIob'; readonly available: number }
  | null;

/** Warning shown above the Recommended Bolus card, in Trio's precedence. */
export function recommendationWarning(i: RecommendationCardInput): RecommendationWarning {
  const iobAvailable = i.maxIOB - i.iob;
  const stale = i.lastLoopDate == null || i.now - i.lastLoopDate > 15 * 60_000;
  if (stale) return { kind: 'stale' };
  if (i.currentBG < 54) return { kind: 'veryLow' };
  if (i.minPredBG < 54) return { kind: 'forecastLow' };
  if (i.factoredInsulin > i.maxBolus && i.maxBolus <= iobAvailable) return { kind: 'maxBolus' };
  if (i.factoredInsulin > 0 && i.factoredInsulin > iobAvailable) return i.iob > i.maxIOB ? { kind: 'iobAboveMax' } : { kind: 'maxIob', available: iobAvailable };
  return null;
}

/** `isRoundedForPump`: shows "Rounded for pump" when the displayed values differ. */
export function isRoundedForPump(i: RecommendationCardInput): boolean {
  if (!(i.factoredInsulin > 0)) return false;
  const iobAvailable = i.maxIOB - i.iob;
  const reference = i.factoredInsulin > iobAvailable ? iobAvailable : i.factoredInsulin;
  return insulinFormatter(i.insulinCalculated, 'down', false, 'en') !== insulinFormatter(reference, 'down', false, 'en');
}
