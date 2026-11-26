import { useColorScheme } from 'react-native';
import { useSettings } from '@/runtime/settings-store';

/**
 * Trio dev palette, taken from Trio/Resources/Assets.xcassets/Colors and SwiftUI system
 * colors. Names follow Trio's Color extensions so ported views read 1:1.
 */
export interface TrioColors {
  readonly dark: boolean;
  /** AppState.trioBackgroundColor gradient */
  readonly bgTop: string;
  readonly bgBottom: string;
  /** Color.chart — list rows / cards */
  readonly chart: string;
  /** Color.tabBar — tint of tab bar, links and secondary buttons */
  readonly tabBar: string;
  /** Color.accentColor / systemBlue — primary buttons */
  readonly accent: string;
  /** Text and icons drawn on `accent` (filled buttons). */
  readonly onAccent: string;
  readonly insulin: string;
  readonly basal: string;
  readonly tempBasal: string;
  readonly uam: string;
  readonly zt: string;
  readonly carbs: string;
  readonly loopGreen: string;
  readonly loopYellow: string;
  readonly loopRed: string;
  readonly loopGray: string;
  readonly primary: string;
  readonly secondary: string;
  readonly tertiary: string;
  readonly separator: string;
  readonly fill: string;
  readonly glassStroke: string;
  readonly orange: string;
  readonly red: string;
  readonly green: string;
  readonly purple: string;
}

export const TRIO_DARK: TrioColors = {
  dark: true,
  bgTop: '#0A2237',
  bgBottom: '#030F1C',
  chart: '#21212E',
  tabBar: '#7D8CF2',
  accent: '#0A84FF',
  onAccent: '#FFFFFF',
  insulin: '#1E96FC',
  basal: '#1E96FC',
  tempBasal: '#1E96FC',
  uam: '#D12BF7',
  zt: '#7161EF',
  carbs: '#FF9F0A',
  loopGreen: '#6FCF97',
  loopYellow: '#FFC145',
  loopRed: '#EB5757',
  loopGray: '#BDBDBD',
  primary: '#FFFFFF',
  secondary: 'rgba(235,235,245,0.6)',
  tertiary: 'rgba(235,235,245,0.3)',
  separator: 'rgba(84,84,88,0.65)',
  fill: 'rgba(118,118,128,0.24)',
  glassStroke: 'rgba(255,255,255,0.21)',
  orange: '#FF9F0A',
  red: '#FF453A',
  green: '#30D158',
  purple: '#BF5AF2',
};

export const TRIO_LIGHT: TrioColors = {
  dark: false,
  bgTop: '#F3F3F4',
  bgBottom: '#F3F3F4',
  chart: '#FFFFFF',
  tabBar: '#7D8CF2',
  accent: '#007AFF',
  onAccent: '#FFFFFF',
  insulin: '#1E96FC',
  basal: '#1E96FC',
  tempBasal: '#A2D6F9',
  uam: '#D12BF7',
  zt: '#7161EF',
  carbs: '#FF9500',
  loopGreen: '#6FCF97',
  loopYellow: '#FFC145',
  loopRed: '#EB5757',
  loopGray: '#BDBDBD',
  primary: '#000000',
  secondary: 'rgba(60,60,67,0.6)',
  tertiary: 'rgba(60,60,67,0.3)',
  separator: 'rgba(60,60,67,0.29)',
  fill: 'rgba(120,120,128,0.2)',
  glassStroke: 'rgba(0,0,0,0.21)',
  orange: '#FF9500',
  red: '#FF3B30',
  green: '#34C759',
  purple: '#AF52DE',
};

export function useTrioColors(): TrioColors {
  const system = useColorScheme();
  const pref = useSettings((s) => s.appearance);
  const mode = pref === 'system' ? system : pref;
  return mode === 'light' ? TRIO_LIGHT : TRIO_DARK;
}

/** Trio's glucose colouring (static scheme): low red, high yellow, in range green. */
export function trioGlucoseColor(c: TrioColors, mgdl: number, low = 70, high = 180): string {
  if (mgdl < low) return c.loopRed;
  if (mgdl > high) return c.loopYellow;
  return c.loopGreen;
}

/** Fill of a disabled filled button (Trio's system grays). */
export function disabledFill(c: TrioColors): string {
  return c.dark ? '#3A3A3C' : '#D1D1D6';
}

/** Text/icon colour on a filled button: always white, as in Trio. */
export function onFill(_c: TrioColors, _bg: string): string {
  return '#FFFFFF';
}
