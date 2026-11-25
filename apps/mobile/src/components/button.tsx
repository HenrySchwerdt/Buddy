import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from '@/trio/symbol';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme/use-theme';
import { radius, space } from '@/theme/tokens';
import { Text } from './text';

interface Props {
  readonly label: string;
  readonly onPress: () => void;
  readonly icon?: SFSymbol;
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  readonly color?: string;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly accessibilityHint?: string;
  readonly compact?: boolean;
}

/** Pressable with haptics and a spring-like press state (opacity + scale only). */
export function Button({ label, onPress, icon, variant = 'primary', color, disabled, loading, style, accessibilityHint, compact }: Props) {
  const theme = useTheme();
  const tint = color ?? (variant === 'danger' ? theme.danger : theme.accent);
  const bg = variant === 'primary' || variant === 'danger' ? tint : variant === 'secondary' ? `${tint}22` : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? '#FFFFFF' : tint;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading }}
      disabled={disabled || loading}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.78 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] },
        style,
      ]}>
      <View style={styles.row}>
        {loading ? <ActivityIndicator color={fg} /> : icon ? <SymbolView name={icon} tintColor={fg} size={compact ? 15 : 18} weight="semibold" /> : null}
        <Text variant="heading" color={fg} style={compact ? { fontSize: 14 } : undefined}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 52, borderRadius: radius.pill, paddingHorizontal: space.xl, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  compact: { minHeight: 38, paddingHorizontal: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
