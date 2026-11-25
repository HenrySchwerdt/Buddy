import type { ComponentProps } from 'react';
import { Platform } from 'react-native';
import { MD_DARK, T, TRIO_DARK } from '@/trio';
import type { Accent } from './model';

/**
 * Trio forces `.preferredColorScheme(.dark)` for the whole onboarding, so these screens use the
 * dark palette regardless of the app appearance setting.
 */
const ANDROID = Platform.OS === 'android';
// Android: the same dark onboarding on Material 3 surfaces (flat background, container cards,
// primary instead of system blue).
const BASE = ANDROID ? MD_DARK : TRIO_DARK;

export const OB = {
  ...BASE,
  /** `Color.chart.opacity(0.65)` */
  card: ANDROID ? MD_DARK.chart : 'rgba(33,33,46,0.65)',
  /** `Color.gray.opacity(0.3)` — empty progress segment */
  track: ANDROID ? MD_DARK.fill : 'rgba(142,142,147,0.3)',
  /** `Color(.systemGray)` — disabled Next */
  systemGray: ANDROID ? MD_DARK.fill : '#8E8E93',
  blue: ANDROID ? MD_DARK.accent : '#0A84FF',
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
