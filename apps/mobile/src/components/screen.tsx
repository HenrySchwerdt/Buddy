import { LinearGradient } from 'expo-linear-gradient';
import type { PropsWithChildren, ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/use-theme';
import { space } from '@/theme/tokens';

interface Props {
  readonly scroll?: boolean;
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
  readonly header?: ReactNode;
  /** Extra bottom space for the floating action bar. */
  readonly bottomInset?: number;
}

/** Full-bleed gradient background (Trio's dark-blue night) with safe-area aware content. */
export function Screen({ children, scroll = true, onRefresh, refreshing = false, header, bottomInset = 0 }: PropsWithChildren<Props>) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const content = (
    <View style={{ paddingTop: insets.top + space.sm, paddingBottom: insets.bottom + 96 + bottomInset, paddingHorizontal: space.lg, gap: space.lg }}>
      {header}
      {children}
    </View>
  );
  return (
    <View style={styles.fill}>
      <LinearGradient colors={[theme.bgTop, theme.bgBottom]} style={StyleSheet.absoluteFill} />
      {theme.dark && <LinearGradient colors={['rgba(30,150,252,0.16)', 'transparent']} start={{ x: 0.1, y: 0 }} end={{ x: 0.7, y: 0.5 }} style={StyleSheet.absoluteFill} />}
      {scroll ? (
        <ScrollView
          contentInsetAdjustmentBehavior="never"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.textMuted} /> : undefined}>
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
