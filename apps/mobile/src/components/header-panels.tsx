import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/use-theme';
import { LoopRing } from './loop-ring';
import { Text } from './text';

interface PumpProps {
  readonly icon: SFSymbol;
  readonly primary: string;
  readonly secondary: string;
  readonly warning?: boolean;
  readonly onPress: () => void;
}

/** Left header panel: reservoir and battery, like Trio's PumpView. */
export function PumpPanel({ icon, primary, secondary, warning, onPress }: PumpProps) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Pump ${primary}, ${secondary}`} style={({ pressed }) => [styles.side, { opacity: pressed ? 0.6 : 1 }]}>
      <SymbolView name={icon} size={20} tintColor={warning ? theme.warning : theme.insulin} />
      <Text variant="value" color={warning ? theme.warning : theme.text}>
        {primary}
      </Text>
      <Text variant="caption" tone="faint" numberOfLines={1}>
        {secondary}
      </Text>
    </Pressable>
  );
}

interface LoopProps {
  readonly minutesAgo: number | null;
  readonly looping: boolean;
  readonly closed: boolean;
  readonly failed: boolean;
  readonly onPress: () => void;
}

/** Right header panel: loop status ring, last run and mode, like Trio's LoopView. */
export function LoopPanel({ minutesAgo, looping, closed, failed, onPress }: LoopProps) {
  const theme = useTheme();
  const label = looping ? 'looping' : minutesAgo === null ? '–' : minutesAgo < 1 ? 'now' : `${minutesAgo} min`;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityHint="Shows the last loop decision" style={({ pressed }) => [styles.side, { alignItems: 'flex-end', opacity: pressed ? 0.6 : 1 }]}>
      <LoopRing size={26} minutesAgo={failed ? 99 : minutesAgo} looping={looping} closed={closed} />
      <Text variant="value">{label}</Text>
      <Text variant="caption" color={closed ? theme.success : theme.textFaint}>
        {closed ? 'Closed loop' : 'Open loop'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  side: { flex: 1, gap: 3, justifyContent: 'center' },
});
