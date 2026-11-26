import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Switch } from 'react-native';
import { useTrioColors } from './colors';

const TRACK = { width: 51, height: 31 };
const THUMB = 27;
const TRAVEL = TRACK.width - THUMB - 4;

/**
 * Trio's `Toggle`: the native UISwitch on iOS; on Android the same 51x31 pill with a white
 * thumb, drawn in JS because Android has no UISwitch.
 */
export function TrioSwitch({ value, onValueChange, disabled, accessibilityLabel, tint }: { value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean; accessibilityLabel?: string; tint?: string }) {
  const c = useTrioColors();
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(progress, { toValue: value ? 1 : 0, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [value, progress]);
  if (Platform.OS === 'ios') {
    return <Switch value={value} disabled={disabled} onValueChange={onValueChange} trackColor={{ true: tint ?? c.tabBar }} accessibilityLabel={accessibilityLabel} />;
  }
  const track = progress.interpolate({ inputRange: [0, 1], outputRange: [c.fill, tint ?? c.tabBar] });
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        void Haptics.selectionAsync();
        onValueChange(!value);
      }}
      style={disabled ? styles.disabled : null}>
      <Animated.View style={[styles.track, { backgroundColor: track }]}>
        <Animated.View style={[styles.thumb, { transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, TRAVEL] }) }] }]} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: TRACK.width, height: TRACK.height, borderRadius: TRACK.height / 2, padding: 2 },
  thumb: { width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  disabled: { opacity: 0.5 },
});
