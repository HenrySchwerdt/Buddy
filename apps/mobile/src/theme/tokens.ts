import { Platform } from 'react-native';

/**
 * Design tokens. Palette derives from Trio's asset catalog (deep night blues, loop
 * green/yellow/red, IOB/ZT/COB/UAM prediction colours) so the app feels familiar to
 * Trio users, with glass surfaces layered on top.
 */
const palette = {
  night950: '#030F1C',
  night900: '#0A2237',
  night800: '#12304A',
  night700: '#1B4062',
  insulin: '#1E96FC',
  basal: '#1E96FC',
  zt: '#7161EF',
  uam: '#D12BF7',
  cob: '#FF9F0A',
  loopGreen: '#6FCF97',
  loopYellow: '#FFC145',
  loopRed: '#EB5757',
  white: '#FFFFFF',
  ink: '#0B1726',
} as const;

export interface Theme {
  readonly dark: boolean;
  readonly bgTop: string;
  readonly bgBottom: string;
  readonly surface: string;
  readonly surfaceStrong: string;
  readonly stroke: string;
  readonly text: string;
  readonly textMuted: string;
  readonly textFaint: string;
  readonly accent: string;
  readonly inRange: string;
  readonly high: string;
  readonly low: string;
  readonly veryLow: string;
  readonly targetBand: string;
  readonly grid: string;
  readonly insulin: string;
  readonly basal: string;
  readonly zt: string;
  readonly uam: string;
  readonly cob: string;
  readonly danger: string;
  readonly success: string;
  readonly warning: string;
}

export const darkTheme: Theme = {
  dark: true,
  bgTop: palette.night900,
  bgBottom: palette.night950,
  surface: 'rgba(255,255,255,0.06)',
  surfaceStrong: 'rgba(255,255,255,0.10)',
  stroke: 'rgba(255,255,255,0.12)',
  text: '#F4F8FC',
  textMuted: 'rgba(230,240,250,0.68)',
  textFaint: 'rgba(230,240,250,0.40)',
  accent: palette.insulin,
  inRange: palette.loopGreen,
  high: palette.loopYellow,
  low: palette.loopRed,
  veryLow: '#FF3B5C',
  targetBand: 'rgba(111,207,151,0.10)',
  grid: 'rgba(255,255,255,0.07)',
  insulin: palette.insulin,
  basal: palette.basal,
  zt: palette.zt,
  uam: palette.uam,
  cob: palette.cob,
  danger: palette.loopRed,
  success: palette.loopGreen,
  warning: palette.loopYellow,
};

export const lightTheme: Theme = {
  dark: false,
  bgTop: '#EEF4FA',
  bgBottom: '#DCE7F2',
  surface: 'rgba(255,255,255,0.72)',
  surfaceStrong: 'rgba(255,255,255,0.92)',
  stroke: 'rgba(10,34,55,0.10)',
  text: palette.ink,
  textMuted: 'rgba(11,23,38,0.64)',
  textFaint: 'rgba(11,23,38,0.38)',
  accent: '#0A7BE0',
  inRange: '#2E9E62',
  high: '#C98A00',
  low: '#D23B3B',
  veryLow: '#C2002F',
  targetBand: 'rgba(46,158,98,0.10)',
  grid: 'rgba(11,23,38,0.07)',
  insulin: '#0A7BE0',
  basal: '#0A7BE0',
  zt: '#5A49D6',
  uam: '#B01ED6',
  cob: '#E08600',
  danger: '#D23B3B',
  success: '#2E9E62',
  warning: '#C98A00',
};

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 36 } as const;
export const radius = { sm: 10, md: 16, lg: 24, pill: 999 } as const;

/**
 * Trio uses SF Rounded (`.fontDesign(.rounded)`) for numbers and headings. React Native
 * exposes it on iOS as `ui-rounded` (weights via fontWeight); Android falls back to Nunito.
 */
const rounded = Platform.OS === 'ios';
export const fonts = {
  black: rounded ? 'ui-rounded' : 'Nunito_900Black',
  extraBold: rounded ? 'ui-rounded' : 'Nunito_800ExtraBold',
  bold: rounded ? 'ui-rounded' : 'Nunito_700Bold',
  semiBold: rounded ? 'ui-rounded' : 'Nunito_600SemiBold',
} as const;
const w = (weight: '600' | '700' | '800' | '900') => (rounded ? { fontWeight: weight } : {});

export const type = {
  hero: { fontFamily: fonts.black, ...w('700'), fontSize: 44, letterSpacing: -1, fontVariant: ['tabular-nums' as const] },
  display: { fontFamily: fonts.extraBold, ...w('700'), fontSize: 30, letterSpacing: -0.5, fontVariant: ['tabular-nums' as const] },
  title: { fontFamily: fonts.black, ...w('700'), fontSize: 30, letterSpacing: -0.5 },
  heading: { fontFamily: fonts.bold, ...w('600'), fontSize: 17, letterSpacing: -0.1 },
  value: { fontFamily: fonts.extraBold, ...w('700'), fontSize: 17, fontVariant: ['tabular-nums' as const] },
  body: { fontSize: 15, fontWeight: '500' as const },
  caption: { fontSize: 12, fontWeight: '600' as const, letterSpacing: 0.1 },
  overline: { fontFamily: fonts.extraBold, ...w('700'), fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase' as const },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12 },
  number: { fontVariant: ['tabular-nums' as const] },
} as const;

export const motion = { fast: 150, normal: 280 } as const;

/** Colour for a glucose value (mg/dL). */
export function glucoseColor(theme: Theme, mgdl: number, low = 70, high = 180): string {
  if (mgdl < 54) return theme.veryLow;
  if (mgdl < low) return theme.low;
  if (mgdl > high) return theme.high;
  return theme.inRange;
}
