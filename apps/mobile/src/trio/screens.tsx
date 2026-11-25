import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import type { PropsWithChildren, ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CapsuleButton } from './buttons';
import { useTrioColors } from './colors';
import { T } from './text';

/**
 * Bottom space for tab screens: iOS reserves room under Trio's floating glass tab bar; Android's
 * navigation bar sits below the content, so only the FAB (56 dp + margins) needs clearing.
 */
export const TAB_BAR_SPACE = Platform.OS === 'android' ? 88 : 96;

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
  // Android: pushed screens put the title in a Material top app bar next to the back arrow;
  // tab roots keep a large title under the actions (Material "large top app bar").
  const android = Platform.OS === 'android';
  const appBarTitle = android && back ? (title ?? inlineTitle) : undefined;
  // Tab roots on Android show their name as the large title, whether Trio inlines it or not.
  const largeTitle = android ? (back ? undefined : (title ?? inlineTitle)) : title;
  const toolbar =
    Platform.OS === 'android' ? (
      <View style={styles.mdAppBar}>
        {back ? <CapsuleButton icon="chevron.left" onPress={() => router.back()} accessibilityLabel="Back" /> : leading ? <View>{leading}</View> : <View style={{ width: 4 }} />}
        <T style={styles.mdTitle} numberOfLines={1} accessibilityRole="header">
          {appBarTitle ?? ''}
        </T>
        {trailing ? <View>{trailing}</View> : null}
      </View>
    ) : (
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
      {largeTitle ? (
        <T style_="largeTitle" style={{ marginLeft: 4 }} accessibilityRole="header">
          {largeTitle}
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

/**
 * Sheet content with Trio's header: [Close]  Title  [Action].
 * `fitContent` is for formSheets sized with `sheetAllowedDetents: 'fitToContents'`: the sheet takes the
 * content's height, so the root must not flex and must not contain a ScrollView (RNScreens lays those out wrong).
 */
export function SheetScreen({ title, leading, trailing, children, scroll = true, footer, fitContent = false }: PropsWithChildren<{ title: string; leading?: ReactNode; trailing?: ReactNode; scroll?: boolean; footer?: ReactNode; fitContent?: boolean }>) {
  const insets = useSafeAreaInsets();
  if (fitContent) {
    return (
      <View>
        <TrioBackground />
        <SheetHeader title={title} leading={leading} trailing={trailing} />
        <View style={{ gap: 16, padding: 16, paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
          {children}
          {footer}
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <TrioBackground />
      <SheetHeader title={title} leading={leading} trailing={trailing} />
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

/**
 * Sheet header. iOS: Trio's [Close]  Title  [Action] with a centred title.
 * Android: Material 3 small top app bar — leading action, left-aligned title, trailing actions.
 */
function SheetHeader({ title, leading, trailing }: { title: string; leading?: ReactNode; trailing?: ReactNode }) {
  if (Platform.OS === 'android') {
    return (
      <View style={styles.mdAppBar}>
        {leading ? <View>{leading}</View> : <View style={{ width: 4 }} />}
        <T style={styles.mdTitle} numberOfLines={1} accessibilityRole="header">
          {title}
        </T>
        {trailing ? <View>{trailing}</View> : null}
      </View>
    );
  }
  return (
    <View style={[styles.toolbar, { marginTop: 12 }]}>
      <View style={styles.centerTitle} pointerEvents="none">
        <T style_="headline" style={[styles.sheetTitle, { fontSize: 19 }]} numberOfLines={1} accessibilityRole="header">
          {title}
        </T>
      </View>
      <View style={styles.side}>{leading}</View>
      <View style={{ flex: 1 }} />
      <View style={[styles.side, { alignItems: 'flex-end' }]}>{trailing}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  mdAppBar: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 64, paddingHorizontal: 8 },
  mdTitle: { flex: 1, fontSize: 22, fontWeight: '500', paddingHorizontal: 8 },
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: 56 },
  side: { minWidth: 44, maxWidth: '45%' },
  inlineTitle: { flex: 1, textAlign: 'center' },
  sheetTitle: { textAlign: 'center' },
  centerTitle: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, paddingHorizontal: 96, justifyContent: 'center' },
});
