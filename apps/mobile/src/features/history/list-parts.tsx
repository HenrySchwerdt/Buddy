import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useRef, type PropsWithChildren } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import Swipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { T, useTrioColors } from '@/trio';

const ACTION_W = 74;

export interface SwipeAction {
  readonly label: string;
  readonly icon: SFSymbol;
  readonly color: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}

/** `.swipeActions { … }`: trailing icon buttons revealed by swiping left. */
export function SwipeRow({ actions, children }: PropsWithChildren<{ actions: readonly SwipeAction[] }>) {
  const c = useTrioColors();
  const ref = useRef<SwipeableMethods>(null);
  if (actions.length === 0) return <>{children}</>;
  return (
    <Swipeable
      ref={ref}
      friction={1.5}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={() => (
        <View style={{ flexDirection: 'row' }}>
          {actions.map((a) => (
            <Pressable
              key={a.label}
              disabled={a.disabled}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              onPress={() => {
                ref.current?.close();
                a.onPress();
              }}
              style={({ pressed }) => [styles.action, { backgroundColor: a.disabled ? (c.dark ? '#3A3A3C' : '#D1D1D6') : a.color, opacity: pressed ? 0.8 : 1 }]}>
              <SymbolView name={a.icon} size={20} tintColor="#FFFFFF" />
            </Pressable>
          ))}
        </View>
      )}>
      <View style={{ backgroundColor: c.chart }}>{children}</View>
    </Swipeable>
  );
}

/** ContentUnavailableView("No data.", systemImage:). */
export function NoData({ icon }: { icon: SFSymbol }) {
  const c = useTrioColors();
  return (
    <View style={styles.empty}>
      <SymbolView name={icon} size={60} tintColor={c.secondary} weight="medium" />
      <T style_="title2">No data.</T>
    </View>
  );
}

/** Trio's glassActionSheet with a single destructive "Delete". */
export function confirmDelete(title: string, message: string | undefined, onDelete: () => void): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({ title, message, options: ['Delete', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 }, (i) => {
      if (i === 0) onDelete();
    });
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onDelete },
  ]);
}

export function Dot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} accessibilityElementsHidden importantForAccessibility="no" />;
}

const styles = StyleSheet.create({
  action: { width: ACTION_W, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 16, paddingVertical: 28 },
  dot: { width: 13, height: 13, borderRadius: 6.5 },
});
