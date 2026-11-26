import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { T, useTrioColors } from '@/trio';
import type { LifecycleTheme, SensorLifecycle } from './sensor-lifecycle';

/** Outer diameter: the bobble is ~130 pt; the arc sits 10 pt outside its ring (SensorLifecycleArcView). */
export const ARC_DIAMETER = 146;
const STROKE = 4;

/** Countdown arc around the glucose bobble: starts full and drains toward 12 o'clock as the phase elapses. */
export function SensorLifecycleArc({ lifecycle }: { lifecycle: SensorLifecycle }) {
  const c = useTrioColors();
  const color = lifecycle.arc === 'critical' ? c.loopRed : lifecycle.arc === 'warning' ? c.orange : c.loopGreen;
  const r = (ARC_DIAMETER - STROKE) / 2;
  const circ = 2 * Math.PI * r;
  const remaining = 1 - Math.max(0, Math.min(1, lifecycle.progress));
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.center}>
        <Svg width={ARC_DIAMETER} height={ARC_DIAMETER}>
          <Circle cx={ARC_DIAMETER / 2} cy={ARC_DIAMETER / 2} r={r} stroke={c.secondary} strokeOpacity={0.4} strokeWidth={STROKE} fill="none" />
          {remaining > 0 ? (
            // mirrored: the arc extends counterclockwise and drains back into 12 o'clock
            <Circle cx={ARC_DIAMETER / 2} cy={ARC_DIAMETER / 2} r={r} stroke={color} strokeWidth={STROKE} strokeLinecap="round" fill="none" strokeDasharray={`${circ * remaining} ${circ}`} transform={`translate(${ARC_DIAMETER} 0) scale(-1 1) rotate(-90 ${ARC_DIAMETER / 2} ${ARC_DIAMETER / 2})`} />
          ) : null}
        </Svg>
      </View>
    </View>
  );
}

/** Text-only status below the bobble (SensorStatusTagView). */
export function SensorStatusTag({ text, theme }: { text: string; theme: LifecycleTheme }) {
  const c = useTrioColors();
  const color = theme === 'green' ? c.loopGreen : theme === 'orange' ? c.orange : theme === 'red' ? c.loopRed : c.secondary;
  return (
    <T style_="callout" rounded weight="700" color={color} numberOfLines={1} style={{ marginBottom: -16 }}>
      {text}
    </T>
  );
}

const styles = StyleSheet.create({ center: { flex: 1, alignItems: 'center', justifyContent: 'center' } });
