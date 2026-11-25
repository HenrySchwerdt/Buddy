import { toMmol, type GlucoseUnit } from '@buddy/core';

/** Trio's discrete band colours (DynamicGlucoseColor.swift: HSB with s 0.6, b 0.9). */
export const DYN = {
  red: '#E65C5C',
  orange: '#E6A15C',
  green: '#5CE65C',
  teal: '#5CE6C4',
  blue: '#5CB8E6',
  indigo: '#5C68E6',
  purple: '#A15CE6',
} as const;

/** SwiftUI Color.blue / .teal / .purple / .orange (dark appearance). */
export const SYS = { blue: '#0A84FF', teal: '#40CBE0', purple: '#BF5AF2', orange: '#FF9F0A', green: '#30D158' } as const;

/** `#RRGGBB` + opacity → `#RRGGBBAA`. */
export const alpha = (hex: string, o: number) => `${hex}${Math.round(o * 255).toString(16).padStart(2, '0')}`;

const nf = (min: number, max: number) => new Intl.NumberFormat(undefined, { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: false });
const pf = (min: number, max: number) => new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: min, maximumFractionDigits: max });

/** `.number.precision(.fractionLength(n))` */
export const fixed = (v: number, digits: number) => nf(digits, digits).format(v);
/** `.number.precision(.fractionLength(0...n))` */
export const upTo = (v: number, digits: number) => nf(0, digits).format(v);
/** `.upToOneDecimalPercent` — input is a fraction (0…1). */
export const pctUpToOne = (fraction: number) => pf(0, 1).format(fraction);
/** `.oneDecimalPercent` */
export const pctOne = (fraction: number) => pf(1, 1).format(fraction);
/** `.wholePercent` */
export const pctWhole = (fraction: number) => pf(0, 0).format(fraction);

/** Decimal.formatted(for: units): mg/dL integers, mmol/L one decimal. */
export function glucoseValue(mgdl: number, units: GlucoseUnit): string {
  return units === 'mg/dL' ? fixed(Math.round(mgdl), 0) : fixed(toMmol(mgdl), 1);
}

/** formatted(withUnits:) — "70 mg/dL". */
export const glucoseWithUnit = (mgdl: number, units: GlucoseUnit) => `${glucoseValue(mgdl, units)} ${units}`;

/** Glucose in display units as a number (for chart scales). */
export const inUnits = (mgdl: number, units: GlucoseUnit) => (units === 'mg/dL' ? mgdl : toMmol(mgdl));

export const fmtTimeOfDay = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
