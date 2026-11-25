import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { SymbolView } from '@/trio/symbol';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useTrioColors } from '@/trio';

/**
 * Trio dev tab bar: five icon-only slots on the iOS 26 glass bar — Home, History, a dead
 * middle slot under the overlaid treatment button, Adjustments, Settings.
 */
export default function TabsLayout() {
  const c = useTrioColors();
  return (
    <View style={{ flex: 1 }}>
      <NativeTabs tintColor={c.tabBar} iconColor={c.primary}>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Label hidden />
          <NativeTabs.Trigger.Icon sf="chart.xyaxis.line" md="show_chart" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="history">
          <NativeTabs.Trigger.Label hidden />
          <NativeTabs.Trigger.Icon sf="book.pages" md="menu_book" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="treat">
          <NativeTabs.Trigger.Label hidden />
          <NativeTabs.Trigger.Icon src={require('@/assets/images/transparent.png')} />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="adjustments">
          <NativeTabs.Trigger.Label hidden />
          <NativeTabs.Trigger.Icon sf="slider.horizontal.2.gobackward" md="tune" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="settings">
          <NativeTabs.Trigger.Label hidden />
          <NativeTabs.Trigger.Icon sf="gear" md="settings" />
        </NativeTabs.Trigger>
      </NativeTabs>
      <View pointerEvents="box-none" style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add Treatment"
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.push('/treatment');
          }}
          style={({ pressed }) => [styles.treat, { opacity: pressed ? 0.7 : 1 }]}>
          <SymbolView name="plus.circle.fill" size={46} tintColor={c.tabBar} type="monochrome" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Centre the button on the tab icons: iOS tab bar icons sit 52 pt up, Android's Material bar 66 dp.
  overlay: { position: 'absolute', left: 0, right: 0, bottom: (Platform.OS === 'android' ? 66 : 52) - 27, alignItems: 'center' },
  treat: { paddingHorizontal: 24, paddingVertical: 2 },
});
