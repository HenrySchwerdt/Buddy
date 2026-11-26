import { Platform, Text, type TextProps, type TextStyle } from 'react-native';
import { useTrioColors } from './colors';

/** SwiftUI text styles (iOS default dynamic type sizes, SF Pro / SF Rounded). */
export const TEXT_STYLES = {
  largeTitle: { fontSize: 34, fontWeight: '700', letterSpacing: 0.37 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: 0.36 },
  title2: { fontSize: 22, fontWeight: '700', letterSpacing: 0.35 },
  title3: { fontSize: 20, fontWeight: '600', letterSpacing: 0.38 },
  headline: { fontSize: 17, fontWeight: '600', letterSpacing: -0.41 },
  body: { fontSize: 17, fontWeight: '400', letterSpacing: -0.41 },
  callout: { fontSize: 16, fontWeight: '400', letterSpacing: -0.32 },
  subheadline: { fontSize: 15, fontWeight: '400', letterSpacing: -0.24 },
  footnote: { fontSize: 13, fontWeight: '400', letterSpacing: -0.08 },
  caption: { fontSize: 12, fontWeight: '400' },
  caption2: { fontSize: 11, fontWeight: '400', letterSpacing: 0.07 },
} as const satisfies Record<string, TextStyle>;

/** `.fontDesign(.rounded)`: SF Rounded on iOS; Android has no SF, so Nunito (the closest rounded face) in the nearest weight. */
function roundedFont(weight: TextStyle['fontWeight']): TextStyle {
  if (Platform.OS === 'ios') return { fontFamily: 'ui-rounded' };
  const w = Number(weight === 'bold' ? 700 : (weight ?? 400));
  return { fontFamily: w >= 800 ? 'Nunito_800ExtraBold' : w >= 700 ? 'Nunito_700Bold' : 'Nunito_600SemiBold', fontWeight: 'normal' };
}

export type TrioTextStyle = keyof typeof TEXT_STYLES;

interface Props extends TextProps {
  readonly style_?: TrioTextStyle;
  readonly color?: string;
  readonly secondary?: boolean;
  readonly rounded?: boolean;
  readonly weight?: TextStyle['fontWeight'];
  readonly size?: number;
  readonly align?: TextStyle['textAlign'];
}

/** `Text` with SwiftUI semantics: `<T style_="headline" rounded>` ≙ `.font(.headline).fontDesign(.rounded)`. */
export function T({ style_ = 'body', color, secondary, rounded, weight, size, align, style, ...rest }: Props) {
  const c = useTrioColors();
  const base = TEXT_STYLES[style_];
  return (
    <Text
      {...rest}
      style={[
        base,
        rounded ? roundedFont(weight ?? base.fontWeight) : null,
        weight ? { fontWeight: weight } : null,
        size ? { fontSize: size } : null,
        { color: color ?? (secondary ? c.secondary : c.primary), textAlign: align },
        style,
      ]}
    />
  );
}
