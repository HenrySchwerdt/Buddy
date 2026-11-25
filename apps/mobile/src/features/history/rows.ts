/**
 * Pure mapping of Buddy data to Trio's History rows (HistoryRootView+Treatments/Meals/Glucose).
 */
import type { CarbEntry, GlucoseReading, InsulinDose, Trend } from '@buddy/core';

export type HistoryMode = 'treatments' | 'meals' | 'glucose' | 'adjustments';
export const HISTORY_MODES = [
  { value: 'treatments', label: 'Treatments' },
  { value: 'meals', label: 'Meals' },
  { value: 'glucose', label: 'Glucose' },
  { value: 'adjustments', label: 'Adjustments' },
] as const satisfies readonly { value: HistoryMode; label: string }[];

/** History.TreatmentType, in Trio's order. */
export type TreatmentType = 'bolus' | 'externalBolus' | 'smb' | 'tempBasal' | 'suspend' | 'other';
export const TREATMENT_TYPES: readonly { value: TreatmentType; label: string }[] = [
  { value: 'bolus', label: 'Bolus' },
  { value: 'externalBolus', label: 'External Bolus' },
  { value: 'smb', label: 'SMB' },
  { value: 'tempBasal', label: 'Temp Basal' },
  { value: 'suspend', label: 'Suspend' },
  { value: 'other', label: 'Other' },
];

const DAY_MS = 86_400_000;

export interface TreatmentRow {
  readonly id: string;
  readonly date: number;
  readonly type: TreatmentType;
  readonly dot: 'insulin' | 'tempBasal' | 'gray';
  readonly title: string;
  readonly amount?: string;
  readonly duration?: string;
  /**
   * Trio only offers deletion for bolus events it may remove. Every Buddy dose is reported
   * by the pump, so none is deletable (there is no external/manual insulin entry yet).
   */
  readonly deletable: boolean;
}

/** Formatter.decimalFormatterWithThreeFractionDigits (up to three decimals). */
export const upTo3 = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(v);
/** Formatter.decimalFormatterWithTwoFractionDigits. */
export const upTo2 = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);

/** Duration.formattedTimeSpan(): "30m", "1h", "1h 30m". */
export function timeSpan(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function treatmentRows(doses: readonly InsulinDose[], now: number): TreatmentRow[] {
  return doses
    .filter((d) => d.date >= now - DAY_MS && d.date <= now)
    .map((d): TreatmentRow => {
      switch (d.kind) {
        case 'bolus':
        case 'smb':
          return { id: d.id, date: d.date, type: d.kind, dot: 'insulin', title: d.kind === 'smb' ? 'SMB' : 'Bolus', amount: `${upTo3(d.units)} U`, deletable: false };
        case 'tempBasal':
          return {
            id: d.id,
            date: d.date,
            type: 'tempBasal',
            dot: 'tempBasal',
            title: 'Temp Basal',
            amount: `${upTo3(d.rate)} U/hr`,
            duration: d.durationMin > 0 ? timeSpan(d.durationMin) : undefined,
            deletable: false,
          };
        case 'suspend':
          return { id: d.id, date: d.date, type: 'suspend', dot: 'gray', title: 'PumpSuspend', deletable: false };
      }
    })
    .sort((a, b) => b.date - a.date);
}

export interface MealRow {
  readonly id: string;
  readonly date: number;
  readonly amount: string;
  readonly entry: CarbEntry;
}

export function mealRows(carbs: readonly CarbEntry[], now: number, showFuture: boolean): MealRow[] {
  return carbs
    .filter((c) => c.date >= now - DAY_MS && (showFuture || c.date <= now))
    .map((c) => ({ id: c.id, date: c.date, amount: `${upTo2(c.grams)} g`, entry: c }))
    .sort((a, b) => b.date - a.date);
}

/** BloodGlucose.Direction.symbol */
export const TREND_SYMBOL: Readonly<Record<Trend, string>> = {
  doubleUp: '↑↑',
  singleUp: '↑',
  fortyFiveUp: '↗︎',
  flat: '→',
  fortyFiveDown: '↘︎',
  singleDown: '↓',
  doubleDown: '↓↓',
  unknown: '↔︎',
};

export const MANUAL_SOURCE = 'manual';
export const glucoseKey = (g: GlucoseReading) => `${g.source}:${g.date}`;

export function glucoseRows(glucose: readonly GlucoseReading[], now: number): GlucoseReading[] {
  return glucose.filter((g) => g.date >= now - DAY_MS && g.date <= now).sort((a, b) => b.date - a.date);
}

export const timeOfDay = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
