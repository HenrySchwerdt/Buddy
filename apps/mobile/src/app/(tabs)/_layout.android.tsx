import * as Haptics from 'expo-haptics';
import { router, usePathname } from 'expo-router';
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTrioColors, type TrioColors } from '@/trio';
import { SymbolView, type SFSymbol } from '@/trio/symbol';

/*
 * Android twin of _layout.tsx. Same destinations as Trio, laid out the Android way (Material 3):
 * a NavigationBar with labelled destinations and a pill indicator, and the treatment action as a
 * floating action button instead of an empty middle slot.
 */

const BAR_HEIGHT = 80;
const INDICATOR = { width: 64, height: 32 };
const FAB_SIZE = 56;
const FAB_MARGIN = 16;

interface Destination {
  readonly icon: SFSymbol;
  readonly label: string;
}

const DESTINATIONS: Readonly<Record<string, Destination>> = {
  index: { icon: 'chart.xyaxis.line', label: 'Home' },
  history: { icon: 'book.pages', label: 'History' },
  adjustments: { icon: 'slider.horizontal.2.gobackward', label: 'Adjustments' },
  settings: { icon: 'gear', label: 'Settings' },
};

/** Material 3 surface roles derived from the Trio palette. */
function surfaces(c: TrioColors) {
  return c.dark
    ? { container: '#1B1B21', indicator: '#384379', active: '#E4E1E9', inactive: '#C6C5D0', onFab: '#E4E1E9', fab: '#384379' }
    : { container: '#F5F2FA', indicator: '#DDE1FF', active: '#1B1B21', inactive: '#46464F', onFab: '#0A164B', fab: '#DDE1FF' };
}

export default function TabsLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <NavigationBar {...props} />}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="history" />
        <Tabs.Screen name="treat" />
        <Tabs.Screen name="adjustments" />
        <Tabs.Screen name="settings" />
      </Tabs>
      <TreatmentFab />
    </View>
  );
}

function NavigationBar({ state, navigateToTab, insets }: BottomTabBarProps) {
  const c = useTrioColors();
  const s = surfaces(c);
  return (
    <View style={[styles.bar, { backgroundColor: s.container, paddingBottom: insets.bottom, height: BAR_HEIGHT + insets.bottom }]} accessibilityRole="tablist">
      {state.routes.map((route, index) => {
        const destination = DESTINATIONS[route.name];
        if (!destination) return null;
        const focused = state.index === index;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={destination.label}
            android_ripple={{ color: s.indicator, borderless: true, radius: 40 }}
            onPress={() => {
              if (!focused) navigateToTab(route.key);
            }}
            style={styles.destination}>
            <View style={[styles.indicator, focused ? { backgroundColor: s.indicator } : null]}>
              <SymbolView name={destination.icon} size={24} tintColor={focused ? s.active : s.inactive} />
            </View>
            <Text style={[styles.label, { color: focused ? s.active : s.inactive, fontWeight: focused ? '700' : '500' }]} numberOfLines={1}>
              {destination.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Material FAB for "Add Treatment", floating above the navigation bar at the end edge. */
/** Routes where adding a treatment is the primary action (Material: one FAB, only where it fits). */
const FAB_ROUTES = new Set(['/', '/history']);

function TreatmentFab() {
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  const path = usePathname();
  if (!FAB_ROUTES.has(path)) return null;
  const s = surfaces(c);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add Treatment"
      android_ripple={{ color: 'rgba(255,255,255,0.25)' }}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        router.push('/treatment');
      }}
      style={[styles.fab, { backgroundColor: s.fab, bottom: BAR_HEIGHT + insets.bottom + FAB_MARGIN }]}>
      <SymbolView name="plus" size={28} tintColor={s.onFab} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', paddingTop: 12 },
  destination: { flex: 1, alignItems: 'center', gap: 4 },
  indicator: { width: INDICATOR.width, height: INDICATOR.height, borderRadius: INDICATOR.height / 2, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 12, letterSpacing: 0.5 },
  fab: {
    position: 'absolute',
    right: FAB_MARGIN,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    elevation: 6,
  },
});
