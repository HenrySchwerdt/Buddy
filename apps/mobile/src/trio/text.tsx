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

/**
 * Android: the same roles on the Material 3 type scale (Roboto). SF's tight negative tracking and
 * heavy bold titles are what made Android screens read as "iOS port", so they are not carried over.
 */
const MD_TEXT_STYLES: Record<keyof typeof TEXT_STYLES, TextStyle> = {
  largeTitle: { fontSize: 32, fontWeight: '400' },
  title: { fontSize: 28, fontWeight: '400' },
  title2: { fontSize: 22, fontWeight: '500' },
  title3: { fontSize: 20, fontWeight: '500' },
  headline: { fontSize: 16, fontWeight: '500', letterSpacing: 0.15 },
  body: { fontSize: 16, fontWeight: '400', letterSpacing: 0.5 },
  callout: { fontSize: 15, fontWeight: '400', letterSpacing: 0.25 },
  subheadline: { fontSize: 14, fontWeight: '400', letterSpacing: 0.25 },
  footnote: { fontSize: 12, fontWeight: '400', letterSpacing: 0.4 },
  caption: { fontSize: 12, fontWeight: '400', letterSpacing: 0.4 },
  caption2: { fontSize: 11, fontWeight: '500', letterSpacing: 0.5 },
};

const STYLES = Platform.OS === 'android' ? MD_TEXT_STYLES : TEXT_STYLES;

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
  const base = STYLES[style_];
  return (
    <Text
      {...rest}
      style={[
        base,
        rounded && Platform.OS === 'ios' ? { fontFamily: 'ui-rounded' } : null,
        weight ? { fontWeight: weight } : null,
        size ? { fontSize: size } : null,
        { color: color ?? (secondary ? c.secondary : c.primary), textAlign: align },
        style,
      ]}
    />
  );
}
