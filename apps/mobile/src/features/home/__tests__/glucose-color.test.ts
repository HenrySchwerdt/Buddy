import { describe, expect, it } from 'vitest';
import { bobbleGlucoseColor, glucoseColor, hsbToHex, hueBasedGlucoseColor, STATIC_HIGH, STATIC_IN_RANGE, STATIC_LOW } from '../glucose-color';

const o = { scheme: 'staticColor', low: 70, high: 180, target: 100 } as const;

describe('hsbToHex', () => {
  it('matches SwiftUI Color(hue:saturation:brightness:) for the three key hues', () => {
    expect(hsbToHex(0, 0.6, 0.9)).toBe('#e65c5c');
    expect(hsbToHex(120, 0.6, 0.9)).toBe('#5ce65c');
    expect(hsbToHex(270, 0.6, 0.9)).toBe('#a15ce6');
  });
});

describe('glucoseColor', () => {
  it('static scheme: low red, in range green, high purple, thresholds inclusive', () => {
    expect(glucoseColor(70, o)).toBe(STATIC_LOW);
    expect(glucoseColor(100, o)).toBe(STATIC_IN_RANGE);
    expect(glucoseColor(180, o)).toBe(STATIC_HIGH);
  });
  it('dynamic scheme interpolates between fixed 55 and 220 ends, ignoring the user thresholds', () => {
    const d = { ...o, scheme: 'dynamicColor' } as const;
    expect(glucoseColor(40, d)).toBe(STATIC_LOW);
    expect(glucoseColor(100, d)).toBe(STATIC_IN_RANGE);
    expect(glucoseColor(300, d)).toBe(STATIC_HIGH);
    expect(glucoseColor(75, d)).toBe(hueBasedGlucoseColor(75, 220, 55, 100));
    expect(glucoseColor(75, d)).not.toBe(STATIC_LOW);
  });
});

describe('bobbleGlucoseColor', () => {
  it('uses primary text inside the range and the scheme colour outside it', () => {
    expect(bobbleGlucoseColor(120, o, '#fff')).toBe('#fff');
    expect(bobbleGlucoseColor(60, o, '#fff')).toBe(STATIC_LOW);
    expect(bobbleGlucoseColor(200, o, '#fff')).toBe(STATIC_HIGH);
  });
});
