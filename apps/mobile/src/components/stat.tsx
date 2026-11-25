import { StyleSheet, View } from 'react-native';
import { Text } from './text';
import { space } from '@/theme/tokens';

interface Props {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly color?: string;
  readonly accessibilityLabel?: string;
}

/** Compact labelled number used in stat rows. */
export function Stat({ label, value, unit, color, accessibilityLabel }: Props) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={accessibilityLabel ?? `${label} ${value} ${unit ?? ''}`}>
      <Text variant="overline" tone="faint">
        {label}
      </Text>
      <View style={styles.row}>
        <Text variant="heading" color={color} style={{ fontSize: 20, fontVariant: ['tabular-nums'] }}>
          {value}
        </Text>
        {unit ? (
          <Text variant="caption" tone="muted">
            {unit}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stat: { flex: 1, gap: space.xxs },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
});
