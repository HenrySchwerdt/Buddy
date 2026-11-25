import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import type { PropsWithChildren, ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CapsuleButton } from './buttons';
import { useTrioColors } from './colors';
import { T } from './text';

/** Height reserved for Trio's floating tab bar. */
export const TAB_BAR_SPACE = 96;

export function TrioBackground() {
  const c = useTrioColors();
  return <LinearGradient colors={[c.bgTop, c.bgBottom]} style={StyleSheet.absoluteFill} />;
}

interface ScreenProps {
  /** Large navigation title ("History", "Adjustments"). */
  readonly title?: string;
  /** Inline centred title (Settings root uses an inline title). */
  readonly inlineTitle?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly scroll?: boolean;
  readonly back?: boolean;
  readonly tabBar?: boolean;
}

/**
 * NavigationStack root/pushed screen: toolbar row (leading/trailing glass capsules),
 * optional large title, gradient background, content inset for the tab bar.
 */
export function TrioScreen({ title, inlineTitle, leading, trailing, scroll = true, back, tabBar = true, children }: PropsWithChildren<ScreenProps>) {
  const insets = useSafeAreaInsets();
  const toolbar = (
    <View style={styles.toolbar}>
      <View style={styles.side}>{back ? <CapsuleButton icon="chevron.left" onPress={() => router.back()} accessibilityLabel="Back" /> : leading}</View>
      {inlineTitle ? (
        <T style_="headline" style={styles.inlineTitle} numberOfLines={1}>
          {inlineTitle}
        </T>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      <View style={[styles.side, { alignItems: 'flex-end' }]}>{trailing}</View>
    </View>
  );
  const body = (
    <View style={{ gap: 16, paddingHorizontal: 16, paddingBottom: insets.bottom + (tabBar ? TAB_BAR_SPACE : 24) }}>
      {title ? (
        <T style_="largeTitle" style={{ marginLeft: 4 }} accessibilityRole="header">
          {title}
        </T>
      ) : null}
      {children}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <TrioBackground />
      <View style={{ paddingTop: insets.top }}>{toolbar}</View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {scroll ? (
          <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="never" showsVerticalScrollIndicator={false}>
            {body}
          </ScrollView>
        ) : (
          body
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

/** Sheet content with Trio's header: [Close]  Title  [Action]. */
export function SheetScreen({ title, leading, trailing, children, scroll = true, footer }: PropsWithChildren<{ title: string; leading?: ReactNode; trailing?: ReactNode; scroll?: boolean; footer?: ReactNode }>) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1 }}>
      <TrioBackground />
      <View style={[styles.toolbar, { marginTop: 12 }]}>
        <View style={styles.side}>{leading}</View>
        <T style_="headline" style={[styles.inlineTitle, { fontSize: 19 }]} numberOfLines={1}>
          {title}
        </T>
        <View style={[styles.side, { alignItems: 'flex-end' }]}>{trailing}</View>
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {scroll ? (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 16, padding: 16, paddingTop: 8, paddingBottom: insets.bottom + 24 }}>
            {children}
          </ScrollView>
        ) : (
          <View style={{ flex: 1, gap: 16, padding: 16, paddingTop: 8 }}>{children}</View>
        )}
      </KeyboardAvoidingView>
      {footer ? <View style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 8 }}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: 56 },
  side: { minWidth: 44, maxWidth: '45%' },
  inlineTitle: { flex: 1, textAlign: 'center' },
});
