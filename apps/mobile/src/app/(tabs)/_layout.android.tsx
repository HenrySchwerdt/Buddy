import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, View } from 'react-native';
import { QuickPickHost } from '@/features/home/quick-pick-sheet';
import { openQuickPick } from '@/features/home/quick-pick-store';
import { GlassPanel, useTrioColors } from '@/trio';
import { SymbolView, type SFSymbol } from '@/trio/symbol';

/*
 * Android twin of _layout.tsx (Metro picks this file on Android). `NativeTabs` renders a Material
 * navigation bar there, so the Trio tab bar is drawn in JS instead: the same five icon-only slots
 * in a floating capsule, with the treatment button in the middle slot.
 */

const BAR_HEIGHT = 62;
const BAR_MARGIN = 21;
const SELECTION = { width: 62, height: 48 };

const DESTINATIONS: Readonly<Record<string, { icon: SFSymbol; label: string }>> = {
  index: { icon: 'chart.xyaxis.line', label: 'Home' },
  history: { icon: 'book.pages', label: 'History' },
  adjustments: { icon: 'slider.horizontal.2.gobackward', label: 'Adjustments' },
  settings: { icon: 'gear', label: 'Settings' },
};

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <TrioTabBar {...props} />}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="history" />
      <Tabs.Screen name="treat" />
      <Tabs.Screen name="adjustments" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

function TrioTabBar({ state, navigateToTab, insets }: BottomTabBarProps) {
  const c = useTrioColors();
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: Math.max(insets.bottom, 8) }]}>
      <GlassPanel radius={BAR_HEIGHT / 2} style={styles.bar}>
        <View style={styles.slots} accessibilityRole="tablist">
          {state.routes.map((route, index) => {
            if (route.name === 'treat') {
              return (
                <Pressable
                  key={route.key}
                  accessibilityRole="button"
                  accessibilityLabel="Add Treatment"
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    router.push('/treatment');
                  }}
                  onLongPress={openQuickPick}
                  delayLongPress={500}
                  style={({ pressed }) => [styles.slot, { opacity: pressed ? 0.7 : 1 }]}>
                  <SymbolView name="plus.circle.fill" size={46} tintColor={c.tabBar} type="monochrome" />
                </Pressable>
              );
            }
            const destination = DESTINATIONS[route.name];
            if (!destination) return null;
            const focused = state.index === index;
            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={destination.label}
                onPress={() => {
                  if (!focused) navigateToTab(route.key);
                }}
                style={styles.slot}>
                <View style={[styles.selection, focused ? { backgroundColor: c.fill } : null]}>
                  <SymbolView name={destination.icon} size={26} tintColor={focused ? c.tabBar : c.primary} weight="medium" />
                </View>
              </Pressable>
            );
          })}
        </View>
      </GlassPanel>
      <QuickPickHost />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, paddingHorizontal: BAR_MARGIN },
  bar: { height: BAR_HEIGHT, justifyContent: 'center' },
  slots: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  slot: { flex: 1, alignItems: 'center', justifyContent: 'center', height: BAR_HEIGHT },
  selection: { width: SELECTION.width, height: SELECTION.height, borderRadius: SELECTION.height / 2, alignItems: 'center', justifyContent: 'center' },
});
