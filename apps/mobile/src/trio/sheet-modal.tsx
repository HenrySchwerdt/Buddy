import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const IN_MS = 280;
const OUT_MS = 200;

/**
 * Bottom-anchored modal that slides up over a dimming scrim, like UIKit's action sheet and
 * `.presentationDetents` sheets. Android draws these in JS; iOS uses the native controls.
 * `children` receives `dismiss(after)`: it animates out, then calls `after` (the choice callback).
 */
export function SheetModal({ onClosed, children, dismissable = true }: { onClosed: () => void; children: (dismiss: (after?: () => void) => void) => ReactNode; dismissable?: boolean }) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);
  useEffect(() => {
    Animated.timing(progress, { toValue: 1, duration: IN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [progress]);
  const dismiss = useCallback(
    (after?: () => void) => {
      if (closing.current) return;
      closing.current = true;
      Animated.timing(progress, { toValue: 0, duration: OUT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => {
        onClosed();
        after?.();
      });
    },
    [progress, onClosed],
  );
  return (
    <Modal transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={() => { if (dismissable) dismiss(); }}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => dismissable && dismiss()} accessibilityLabel="Dismiss" />
      </Animated.View>
      <Animated.View pointerEvents="box-none" style={[styles.anchor, { paddingBottom: Math.max(insets.bottom, 8), transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }] }]}>
        {children(dismiss)}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(0,0,0,0.4)' },
  anchor: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 8 },
});
