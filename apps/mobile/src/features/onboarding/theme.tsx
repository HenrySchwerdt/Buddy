import type { ComponentProps } from 'react';
import { T, TRIO_DARK } from '@/trio';
import type { Accent } from './model';

/**
 * Trio forces `.preferredColorScheme(.dark)` for the whole onboarding, so these screens use the
 * dark palette regardless of the app appearance setting.
 */
const BASE = TRIO_DARK;

export const OB = {
  ...BASE,
  /** `Color.chart.opacity(0.65)` */
  card: 'rgba(33,33,46,0.65)',
  /** `Color.gray.opacity(0.3)` — empty progress segment */
  track: 'rgba(142,142,147,0.3)',
  /** `Color(.systemGray)` — disabled Next */
  systemGray: '#8E8E93',
  blue: '#0A84FF',
  cyan: '#64D2FF',
  textSecondary: BASE.secondary,
} as const;

export const ACCENT: Record<Accent, string> = { blue: OB.blue, green: OB.green, purple: OB.purple, orange: OB.orange, cyan: OB.cyan };

/** `rgba` from a `#RRGGBB` colour. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** `T` pinned to the onboarding's dark palette. */
export function OT({ color, secondary, ...rest }: ComponentProps<typeof T>) {
  return <T {...rest} color={color ?? (secondary ? OB.secondary : OB.primary)} />;
}
