import type { PropsWithChildren, ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { T, useTrioColors } from '@/trio';

/** Grouped-list surfaces of a plain SwiftUI sheet (PopupView does not use Trio's chart colour). */
export function useSheetSurfaces() {
  const c = useTrioColors();
  // Android: Material surface roles (background / surface container) instead of iOS grouped greys.
  if (Platform.OS === 'android') return { background: c.bgBottom, card: c.chart };
  return c.dark ? { background: '#1C1C1E', card: '#2C2C2E' } : { background: '#F2F2F7', card: '#FFFFFF' };
}

/** `Section("…") { card }` with `listSectionSpacing(0)` and 10 pt row insets. */
export function FormulaSection({ title, children }: PropsWithChildren<{ title: string }>) {
  const s = useSheetSurfaces();
  return (
    <View accessible accessibilityLabel={title}>
      <T style_="headline" secondary style={styles.header} accessibilityRole="header">
        {title}
      </T>
      <View style={[styles.card, { backgroundColor: s.card }]}>{children}</View>
    </View>
  );
}

/** A value cell: header (footnote) above, value (headline), unit (caption2) below. */
export function Cell({ header, value, unit, color, minWidth = 50 }: { header?: string; value: string; unit?: string; color?: string; minWidth?: number }) {
  return (
    <View style={[styles.cell, { minWidth }]}>
      <T style_="footnote" secondary numberOfLines={1} adjustsFontSizeToFit>
        {header ?? ' '}
      </T>
      <T style_="headline" color={color} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </T>
      <T style_="caption2" secondary numberOfLines={1}>
        {unit ?? ' '}
      </T>
    </View>
  );
}

/** Operator: body, secondary, vertically centred on the value line. */
export function Op({ children, grow }: { children: ReactNode; grow?: boolean }) {
  return (
    <View style={[styles.op, grow && { flex: 1, alignItems: 'flex-end' }]}>
      <T secondary>{children}</T>
    </View>
  );
}

/** Solution colour: red below zero, primary at zero, green above. */
export function useSolutionColor() {
  const c = useTrioColors();
  return (v: number) => (v < 0 ? c.red : v === 0 ? c.primary : c.green);
}

/** Bold solution cell after the stretching "=". */
export function Solution({ value, display, unit = 'U' }: { value: number; display: string; unit?: string }) {
  const color = useSolutionColor()(value);
  return (
    <View style={[styles.cell, { minWidth: 45 }]}>
      <T style_="footnote"> </T>
      <T style_="headline" weight="700" color={color} numberOfLines={1}>
        {display}
      </T>
      <T style_="caption2" secondary>
        {unit}
      </T>
    </View>
  );
}

export function FormulaRow({ children }: PropsWithChildren) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  header: { marginLeft: 20, marginTop: 14, marginBottom: 8 },
  card: { borderRadius: 26, borderCurve: 'continuous', paddingHorizontal: 10, paddingVertical: 10, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6 },
  cell: { alignItems: 'center' },
  op: { justifyContent: 'center', paddingHorizontal: 2 },
});
