import { View } from 'react-native';
import { Text } from './text';
import { space } from '@/theme/tokens';

export function ScreenTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.md, marginTop: space.sm }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="title" accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? <Text tone="muted">{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}
