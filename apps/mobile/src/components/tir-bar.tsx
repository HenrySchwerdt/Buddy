import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/use-theme';

interface Props {
  readonly tbr54: number;
  readonly tbr70: number;
  readonly tar180: number;
  readonly tar250: number;
  readonly height?: number;
}

/** Consensus five-band time-in-range bar (very low → very high). */
export function TirBar({ tbr54, tbr70, tar180, tar250, height = 10 }: Props) {
  const t = useTheme();
  const bands = [
    { v: tbr54, c: t.veryLow },
    { v: Math.max(0, tbr70 - tbr54), c: t.low },
    { v: Math.max(0, 100 - tbr70 - tar180), c: t.inRange },
    { v: Math.max(0, tar180 - tar250), c: t.high },
    { v: tar250, c: '#FF7A00' },
  ];
  return (
    <View style={[styles.bar, { height, borderRadius: height / 2, backgroundColor: t.grid }]} accessible accessibilityLabel={`Time in range ${Math.round(100 - tbr70 - tar180)} percent`}>
      {bands.map((b, i) => (b.v > 0 ? <View key={i} style={{ flex: b.v, backgroundColor: b.c }} /> : null))}
    </View>
  );
}

const styles = StyleSheet.create({ bar: { flexDirection: 'row', overflow: 'hidden', gap: 2 } });
