import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Link, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/use-theme';
import { space } from '@/theme/tokens';
import { Text } from './text';

interface Props {
  readonly icon: SFSymbol;
  readonly color: string;
  readonly title: string;
  readonly value?: string;
  readonly href?: Href;
  readonly right?: ReactNode;
  readonly last?: boolean;
}

export function ListRow({ icon, color, title, value, href, right, last }: Props) {
  const theme = useTheme();
  const body = (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.stroke }]}>
      <View style={[styles.icon, { backgroundColor: color }]}>
        <SymbolView name={icon} size={16} tintColor="#fff" />
      </View>
      <Text variant="body" style={{ flex: 1, fontWeight: '600' }}>
        {title}
      </Text>
      {value ? (
        <Text variant="body" tone="muted" numberOfLines={1} style={{ maxWidth: 170 }}>
          {value}
        </Text>
      ) : null}
      {right}
      {href ? <SymbolView name="chevron.right" size={13} tintColor={theme.textFaint} /> : null}
    </View>
  );
  if (!href) return body;
  return (
    <Link href={href} asChild>
      <Pressable accessibilityRole="button" style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
        {body}
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 13 },
  icon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
});
