/** Port of Trio's DynamicGlucoseColor.swift: hue interpolation red - green - purple, or three static colours. */

export type GlucoseColorScheme = 'dynamicColor' | 'staticColor';

/** The dynamic scheme interpolates between these fixed ends instead of the user's thresholds (Trio's "workaround"). */
export const DYNAMIC_LOW = 55;
export const DYNAMIC_HIGH = 220;

const SATURATION = 0.6;
const BRIGHTNESS = 0.9;
const RED_HUE = 0;
const GREEN_HUE = 120;
const PURPLE_HUE = 270;

/** SwiftUI `Color(hue:saturation:brightness:)`; hue in degrees. */
export function hsbToHex(hue: number, saturation: number, brightness: number): string {
  const h = (((hue % 360) + 360) % 360) / 60;
  const c = brightness * saturation;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = brightness - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export const STATIC_LOW = hsbToHex(RED_HUE, SATURATION, BRIGHTNESS);
export const STATIC_IN_RANGE = hsbToHex(GREEN_HUE, SATURATION, BRIGHTNESS);
export const STATIC_HIGH = hsbToHex(PURPLE_HUE, SATURATION, BRIGHTNESS);

/** calculateHueBasedGlucoseColor */
export function hueBasedGlucoseColor(value: number, high: number, low: number, target: number): string {
  let hue: number;
  if (value <= low) hue = RED_HUE;
  else if (value >= high) hue = PURPLE_HUE;
  else if (value <= target) hue = RED_HUE + ((value - low) / (target - low)) * (GREEN_HUE - RED_HUE);
  else hue = GREEN_HUE + ((value - target) / (high - target)) * (PURPLE_HUE - GREEN_HUE);
  return hsbToHex(hue, SATURATION, BRIGHTNESS);
}

export interface GlucoseColorOptions {
  readonly scheme: GlucoseColorScheme;
  /** User thresholds (mg/dL), used by the static scheme. */
  readonly low: number;
  readonly high: number;
  /** Current profile target (mg/dL), the green point of the dynamic scheme. */
  readonly target: number;
}

/** Colour of a chart point, as in GlucoseChartView.pointColor. */
export function glucoseColor(value: number, o: GlucoseColorOptions): string {
  if (o.scheme === 'dynamicColor') return hueBasedGlucoseColor(value, DYNAMIC_HIGH, DYNAMIC_LOW, o.target);
  if (value >= o.high) return STATIC_HIGH;
  if (value <= o.low) return STATIC_LOW;
  return STATIC_IN_RANGE;
}

/** Bobble text colour: plain primary text inside the range, coloured outside it (CurrentGlucoseView). */
export function bobbleGlucoseColor(value: number, o: GlucoseColorOptions, primary: string): string {
  if (value > o.low && value < o.high) return primary;
  return glucoseColor(value, o);
}
