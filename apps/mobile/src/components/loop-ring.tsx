import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '@/theme/use-theme';

interface Props {
  readonly size: number;
  /** Minutes since the last successful loop. */
  readonly minutesAgo: number | null;
  readonly looping: boolean;
  readonly closed: boolean;
}

/** Trio's loop status circle: green < 6 min, yellow < 12 min, red otherwise; pulses while looping. */
export function LoopRing({ size, minutesAgo, looping, closed }: Props) {
  const theme = useTheme();
  const color = minutesAgo === null ? theme.textFaint : minutesAgo < 6 ? theme.success : minutesAgo < 12 ? theme.warning : theme.danger;
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!looping) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const anim = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    anim.start();
    return () => anim.stop();
  }, [looping, pulse]);
  const r = size / 2 - 3;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel={`Loop ${closed ? 'closed' : 'open'}, last run ${minutesAgo ?? 'never'} minutes ago`}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: size / 2, backgroundColor: color, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }) }] },
        ]}
      />
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={3} fill="none" strokeDasharray={closed ? undefined : '4 4'} />
        <Circle cx={size / 2} cy={size / 2} r={r * 0.42} fill={color} />
      </Svg>
    </View>
  );
}
