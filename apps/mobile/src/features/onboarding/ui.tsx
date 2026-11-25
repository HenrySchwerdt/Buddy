import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useState, type PropsWithChildren } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Block, TextBlock } from './texts';
import { OB, OT } from './theme';
import { WheelPicker } from './wheel';

/** `.padding().background(Color.chart.opacity(0.65)).cornerRadius(10)` */
export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** Step body: `VStack(alignment: .leading, spacing: 20)`. */
export function Stack({ children, gap = 20, style }: PropsWithChildren<{ gap?: number; style?: StyleProp<ViewStyle> }>) {
  return <View style={[{ gap }, style]}>{children}</View>;
}

/** `.font(.title3).bold()` heading, optionally with `.padding(.horizontal)`. */
export function StepHeading({ children, inset = true }: PropsWithChildren<{ inset?: boolean }>) {
  return (
    <OT style_="title3" weight="700" style={inset ? styles.inset : undefined} accessibilityRole="header">
      {children}
    </OT>
  );
}

export function Headline({ children, inset = true }: PropsWithChildren<{ inset?: boolean }>) {
  return (
    <OT style_="headline" style={inset ? styles.inset : undefined}>
      {children}
    </OT>
  );
}

/** `.padding(.horizontal).font(.footnote).foregroundStyle(.secondary)` */
export function Footnote({ children, inset = true }: PropsWithChildren<{ inset?: boolean }>) {
  return (
    <OT style_="footnote" secondary style={inset ? styles.inset : undefined}>
      {children}
    </OT>
  );
}

/** Trio's `BulletPoint`. */
export function Bullet({ text, style_ = 'body', secondary }: { text: string; style_?: 'body' | 'footnote'; secondary?: boolean }) {
  return (
    <View style={styles.bullet} accessible accessibilityLabel={text}>
      <OT style_={style_} secondary={secondary}>
        •
      </OT>
      <OT style_={style_} secondary={secondary} style={{ flex: 1 }}>
        {text}
      </OT>
    </View>
  );
}

/** Orange "Important" / blue "Information" box with a 2 pt stroke. */
export function NoticeBox({ kind = 'important', children }: PropsWithChildren<{ kind?: 'important' | 'information' }>) {
  const tint = kind === 'important' ? OB.orange : OB.blue;
  return (
    <View style={[styles.card, { borderWidth: 2, borderColor: tint, gap: 10 }]}>
      <View style={styles.noticeHeader}>
        <SymbolView name={kind === 'important' ? 'exclamationmark.triangle.fill' : 'info.circle.fill'} size={20} tintColor={tint} type="palette" colors={[OB.bgTop, tint]} />
        <OT weight="700" color={tint}>
          {kind === 'important' ? 'Important' : 'Information'}
        </OT>
      </View>
      {children}
    </View>
  );
}

/** Selection card used by the Nightscout setup/import choices. */
export function RadioCard({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.card, styles.rowCard, pressed && { opacity: 0.7 }]}>
      <SymbolView name={selected ? 'largecircle.fill.circle' : 'circle'} size={24} tintColor={selected ? OB.blue : OB.secondary} />
      <OT style={{ flex: 1 }}>{label}</OT>
    </Pressable>
  );
}

export function ToggleCard({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <View style={[styles.card, styles.rowCard, disabled && { opacity: 0.5 }]}>
      <OT style={{ flex: 1 }}>{label}</OT>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: OB.blue }} accessibilityLabel={label} />
    </View>
  );
}

/** `HStack { Text; Spacer; Picker(.menu) }` card: tinted value with ⌃⌄. */
export function MenuPickerCard<V extends string | number>({ label, value, options, onChange }: { label: string; value: V; options: readonly { value: V; label: string }[]; onChange: (v: V) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? String(value);
  const open = () => {
    void Haptics.selectionAsync();
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: label, options: [...options.map((o) => o.label), 'Cancel'], cancelButtonIndex: options.length, userInterfaceStyle: 'dark' }, (i) => {
        if (i < options.length) onChange(options[i]!.value);
      });
    } else {
      Alert.alert(label, undefined, [...options.map((o) => ({ text: o.label, onPress: () => onChange(o.value) })), { text: 'Cancel', style: 'cancel' as const }]);
    }
  };
  return (
    <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${label}, ${current}`} style={({ pressed }) => [styles.card, styles.rowCard, pressed && { opacity: 0.7 }]}>
      <OT style={{ flex: 1 }}>{label}</OT>
      <OT color={OB.blue}>{current}</OT>
      <SymbolView name="chevron.up.chevron.down" size={13} tintColor={OB.blue} weight="semibold" />
    </Pressable>
  );
}

/** Value row that toggles an inline wheel picker (delivery limits, algorithm settings). */
export function ValuePickerCard({
  label,
  value,
  options,
  format,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  options: readonly number[];
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.card, disabled && { opacity: 0.5 }]}>
      <Pressable
        disabled={disabled}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: format(value) }}
        accessibilityHint={open ? 'Closes the value picker' : 'Opens a picker to change this value'}
        style={styles.valueRow}>
        <OT style={{ flex: 1 }}>{label}</OT>
        <OT color={open ? OB.blue : OB.primary}>{format(value)}</OT>
      </Pressable>
      {open ? <WheelPicker label={label} options={options} value={value} format={format} onChange={onChange} disabled={disabled} /> : null}
    </View>
  );
}

function BlockText({ block }: { block: TextBlock | string }) {
  const b: TextBlock = typeof block === 'string' ? { text: block } : block;
  return (
    <OT
      style_="footnote"
      weight={b.bold ? '700' : undefined}
      color={b.color === 'orange' ? OB.orange : b.color === 'primary' ? OB.primary : OB.secondary}
      align={b.center ? 'center' : undefined}
      style={b.padBottom ? { paddingBottom: 16 } : undefined}>
      {b.text}
    </OT>
  );
}

/** Renders the explanatory `description(units:)` blocks below a setting. */
export function DescriptionBlocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <View style={[styles.inset, { gap: 8 }]}>
      {blocks.map((b, i) =>
        'lines' in b ? (
          <View key={i} style={{ gap: 2, alignItems: b.center ? 'center' : 'flex-start' }}>
            {b.lines.map((l, j) => (
              <BlockText key={j} block={l} />
            ))}
          </View>
        ) : (
          <BlockText key={i} block={b} />
        ),
      )}
    </View>
  );
}

/** Permission benefit row: dark glyph in a light circle + text. */
export function BenefitRow({ icon, text }: { icon: SFSymbol; text: string }) {
  return (
    <View style={styles.benefit}>
      <View style={styles.benefitIcon}>
        <SymbolView name={icon} size={24} tintColor={OB.bgTop} />
      </View>
      <OT style={{ flex: 1 }}>{text}</OT>
    </View>
  );
}

export function Divider() {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: OB.separator }} />;
}

export const styles = StyleSheet.create({
  card: { backgroundColor: OB.card, borderRadius: 10, padding: 16, borderCurve: 'continuous' },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inset: { paddingHorizontal: 16 },
  bullet: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  noticeHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  valueRow: { flexDirection: 'row', alignItems: 'center', minHeight: 22 },
  benefit: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  benefitIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.8)', alignItems: 'center', justifyContent: 'center' },
});
