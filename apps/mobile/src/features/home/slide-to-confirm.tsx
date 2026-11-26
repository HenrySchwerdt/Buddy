import { useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import { SymbolView } from '@/trio/symbol';
import { T, useTrioColors } from '@/trio';

const HANDLE = 52;

/** Stand-in for the SlideButton package: drag the handle to the end to confirm. */
export function SlideToConfirm({ label, disabled, onConfirm }: { label: string; disabled: boolean; onConfirm: () => void }) {
  const c = useTrioColors();
  const x = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  const live = useRef({ width: 0, disabled, onConfirm });
  live.current = { width, disabled, onConfirm };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.disabled,
      onPanResponderMove: (_, g) => x.setValue(Math.max(0, Math.min(g.dx, live.current.width - HANDLE))),
      onPanResponderRelease: (_, g) => {
        const max = live.current.width - HANDLE;
        if (g.dx >= max * 0.9) {
          Animated.timing(x, { toValue: 0, duration: 200, useNativeDriver: true }).start();
          live.current.onConfirm();
        } else Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(),
    }),
  ).current;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.track, { backgroundColor: c.fill, opacity: disabled ? 0.5 : 1 }]}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      accessibilityHint="Double tap to confirm"
      onAccessibilityTap={() => !disabled && onConfirm()}>
      <T style_="body" weight="600" secondary align="center" numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.5} style={styles.label}>
        {label}
      </T>
      <Animated.View {...pan.panHandlers} style={[styles.handle, { backgroundColor: c.accent, transform: [{ translateX: x }] }]}>
        <SymbolView name="chevron.right.2" size={18} tintColor="#FFFFFF" weight="bold" />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: HANDLE + 8, borderRadius: (HANDLE + 8) / 2, justifyContent: 'center', padding: 4 },
  label: { paddingHorizontal: HANDLE + 12 },
  handle: { position: 'absolute', left: 4, width: HANDLE, height: HANDLE, borderRadius: HANDLE / 2, alignItems: 'center', justifyContent: 'center' },
});
