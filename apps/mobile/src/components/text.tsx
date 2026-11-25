import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '@/theme/use-theme';
import { type as typeScale } from '@/theme/tokens';

type Variant = keyof typeof typeScale;
type Tone = 'default' | 'muted' | 'faint' | 'accent' | 'danger' | 'success' | 'warning';

interface Props extends TextProps {
  readonly variant?: Variant;
  readonly tone?: Tone;
  readonly color?: string;
  readonly align?: TextStyle['textAlign'];
}

export function Text({ variant = 'body', tone = 'default', color, align, style, ...rest }: Props) {
  const theme = useTheme();
  const tones: Record<Tone, string> = {
    default: theme.text,
    muted: theme.textMuted,
    faint: theme.textFaint,
    accent: theme.accent,
    danger: theme.danger,
    success: theme.success,
    warning: theme.warning,
  };
  return <RNText {...rest} style={[typeScale[variant] as TextStyle, { color: color ?? tones[tone], textAlign: align }, style]} />;
}
