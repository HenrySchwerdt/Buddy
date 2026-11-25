import { chooseValue } from '@/trio/choice-dialog';
import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from '@/trio/symbol';
import type { PropsWithChildren, ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { T, useTrioColors } from '@/trio';
import { SYS } from './format';

/** Stat.StatCard: `.padding()` on a 10 pt rounded rect filled with `secondary.opacity(0.1)`. */
export function StatCard({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const c = useTrioColors();
  return <View style={[styles.card, { backgroundColor: c.dark ? 'rgba(235,235,245,0.06)' : 'rgba(60,60,67,0.06)' }, style]}>{children}</View>;
}

/** "Chart Type" headline + `Picker(.menu)` tinted with the accent colour. */
export function ChartTypeRow<V extends string>({ value, options, onChange, title }: { value: V; options: readonly { value: V; label: string }[]; onChange: (v: V) => void; title: string }) {
  const c = useTrioColors();
  const current = options.find((o) => o.value === value)?.label ?? value;
  const open = () => {
    void Haptics.selectionAsync();
    chooseValue(title, options, value, onChange);
  };
  return (
    <View style={styles.typeRow}>
      <T style_="headline">Chart Type</T>
      <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${title}, ${current}`} style={({ pressed }) => [styles.typeValue, { opacity: pressed ? 0.5 : 1 }]}>
        <T color={c.accent} align="right" style={{ flexShrink: 1 }}>
          {current}
        </T>
        {Platform.OS === 'android' ? <SymbolView name={{ android: 'arrow_drop_down' }} size={24} tintColor={c.accent} /> : <SymbolView name="chevron.up.chevron.down" size={13} tintColor={c.accent} weight="semibold" />}
      </Pressable>
    </View>
  );
}

/** Footnote hint with the `hand.draw.fill` glyph. */
export function Hint({ lines }: { lines: readonly string[] }) {
  const c = useTrioColors();
  return (
    <View style={styles.hint}>
      <SymbolView name="hand.draw.fill" size={17} tintColor={c.primary} />
      <View style={{ flexShrink: 1 }}>
        {lines.map((l) => (
          <T key={l} style_="footnote" secondary>
            {l}
          </T>
        ))}
      </View>
    </View>
  );
}

/** StatChartUtils.statView: subheadline secondary title over the value. */
export function StatView({ title, value, align = 'center' }: { title: string; value: string; align?: 'center' | 'flex-start' }) {
  return (
    <View style={{ gap: 5, alignItems: align }} accessible accessibilityLabel={`${title}, ${value}`}>
      <T style_="subheadline" secondary>
        {title}
      </T>
      <T>{value}</T>
    </View>
  );
}

/** StatChartUtils.legendItem. */
export function LegendItem({ label, color }: { label: string; color: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <T style_="caption" secondary>
        {label}
      </T>
    </View>
  );
}

export function Legend({ items, columns }: { items: readonly { label: string; color: string }[]; columns: number }) {
  return (
    <View style={styles.legend}>
      {items.map((i) => (
        <View key={i.label} style={{ width: `${100 / columns}%` }}>
          <LegendItem label={i.label} color={i.color} />
        </View>
      ))}
    </View>
  );
}

/** ContentUnavailableView(title, systemImage:, description:). */
export function Unavailable({ title, icon, description }: { title: string; icon: SFSymbol; description?: string }) {
  const c = useTrioColors();
  return (
    <View style={styles.unavailable}>
      <SymbolView name={icon} size={52} tintColor={c.secondary} />
      <T style_="title2" align="center">
        {title}
      </T>
      {description ? (
        <T style_="callout" secondary align="center">
          {description}
        </T>
      ) : null}
    </View>
  );
}

/** Selection popover used by all stat charts (bgDarkBlue fill, 2 pt coloured stroke). */
export function ChartPopover({ children, color = SYS.blue, style }: PropsWithChildren<{ color?: string; style?: StyleProp<ViewStyle> }>) {
  const c = useTrioColors();
  return (
    <View pointerEvents="none" style={[styles.popover, { backgroundColor: c.dark ? 'rgba(10,34,55,0.92)' : 'rgba(255,255,255,0.95)', borderColor: color }, style]}>
      {children}
    </View>
  );
}

export function Row({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>;
}

export function Divider() {
  const c = useTrioColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.separator }} />;
}

export type Node = ReactNode;

const styles = StyleSheet.create({
  card: { padding: 16, borderRadius: 10, borderCurve: 'continuous', gap: 16 },
  typeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, gap: 16, minHeight: 44 },
  typeValue: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, maxWidth: '60%' },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, alignSelf: 'center' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  unavailable: { alignItems: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 16 },
  popover: { padding: 16, borderRadius: 10, borderWidth: 2, gap: 4 },
});
