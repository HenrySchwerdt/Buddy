import { Platform, useColorScheme } from 'react-native';
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
  /** Text and icons drawn on `accent` (filled buttons, FAB). */
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

/*
 * Android: Material 3 colour roles from the seed #7D8CF2 (Trio's tab tint, tonal-spot scheme).
 * Surfaces, text and accents follow Material; the data colours (glucose, insulin, carbs, loop
 * state) keep Trio's values so the chart reads the same on both platforms.
 */
export const MD_DARK: TrioColors = {
  ...TRIO_DARK,
  bgTop: '#121318',
  bgBottom: '#121318',
  chart: '#1F1F25',
  tabBar: '#BAC3FF',
  accent: '#BAC3FF',
  onAccent: '#212C61',
  primary: '#E4E1E9',
  secondary: '#C6C5D0',
  tertiary: '#90909A',
  separator: '#46464F',
  fill: '#34343A',
  glassStroke: '#46464F',
  red: '#FFB4AB',
};

export const MD_LIGHT: TrioColors = {
  ...TRIO_LIGHT,
  bgTop: '#FBF8FF',
  bgBottom: '#FBF8FF',
  chart: '#EFEDF4',
  tabBar: '#4F5B92',
  accent: '#4F5B92',
  onAccent: '#FFFFFF',
  primary: '#1B1B21',
  secondary: '#46464F',
  tertiary: '#767680',
  separator: '#C6C5D0',
  fill: '#E4E1E9',
  glassStroke: '#C6C5D0',
  red: '#BA1A1A',
};

const ANDROID = Platform.OS === 'android';

export function useTrioColors(): TrioColors {
  const system = useColorScheme();
  const pref = useSettings((s) => s.appearance);
  const mode = pref === 'system' ? system : pref;
  if (ANDROID) return mode === 'light' ? MD_LIGHT : MD_DARK;
  return mode === 'light' ? TRIO_LIGHT : TRIO_DARK;
}

/** Trio's glucose colouring (static scheme): low red, high yellow, in range green. */
export function trioGlucoseColor(c: TrioColors, mgdl: number, low = 70, high = 180): string {
  if (mgdl < low) return c.loopRed;
  if (mgdl > high) return c.loopYellow;
  return c.loopGreen;
}
