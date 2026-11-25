import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Children, Fragment, isValidElement, type PropsWithChildren, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, Switch, TextInput, View, type KeyboardTypeOptions, type StyleProp, type ViewStyle } from 'react-native';
import { useTrioColors } from './colors';
import { T } from './text';

/**
 * SwiftUI `List(.insetGrouped)` look-alike with Trio's `listRowBackground(Color.chart)`.
 * <Section header="Trio Configuration" footer="…"><NavRow …/></Section>
 */
export function Section({ header, footer, children, style }: PropsWithChildren<{ header?: string; footer?: ReactNode; style?: StyleProp<ViewStyle> }>) {
  const c = useTrioColors();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[styles.section, style]}>
      {header ? (
        <T style_="headline" secondary style={styles.header} accessibilityRole="header">
          {header}
        </T>
      ) : null}
      <View style={[styles.card, { backgroundColor: c.chart }]}>
        {rows.map((row, i) => (
          <Fragment key={row.key ?? i}>
            {row}
            {i < rows.length - 1 ? <View style={[styles.separator, { backgroundColor: c.separator }]} /> : null}
          </Fragment>
        ))}
      </View>
      {footer ? (
        typeof footer === 'string' ? (
          <T style_="footnote" secondary style={styles.footer}>
            {footer}
          </T>
        ) : (
          <View style={styles.footer}>{footer}</View>
        )
      ) : null}
    </View>
  );
}

/** Generic row container (min 52 pt like an iOS 26 list row). */
export function Row({ children, onPress, style, accessibilityLabel }: PropsWithChildren<{ onPress?: () => void; style?: StyleProp<ViewStyle>; accessibilityLabel?: string }>) {
  const c = useTrioColors();
  if (!onPress) return <View style={[styles.row, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fill }, style]}>
      {children}
    </Pressable>
  );
}

export function NavRow({ label, value, icon, iconColor, onPress, external, subtitle }: { label: string; value?: string; icon?: SFSymbol; iconColor?: string; onPress: () => void; external?: boolean; subtitle?: string }) {
  const c = useTrioColors();
  return (
    <Row onPress={onPress} accessibilityLabel={`${label}${value ? `, ${value}` : ''}`}>
      {icon ? <SymbolView name={icon} size={20} tintColor={iconColor ?? c.tabBar} /> : null}
      <View style={{ flex: 1 }}>
        <T>{label}</T>
        {subtitle ? (
          <T style_="footnote" secondary>
            {subtitle}
          </T>
        ) : null}
      </View>
      {value ? <T secondary>{value}</T> : null}
      <SymbolView name={external ? 'arrow.up.right' : 'chevron.right'} size={14} tintColor={c.tertiary} weight="semibold" />
    </Row>
  );
}

export function ValueRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <Row accessibilityLabel={`${label}, ${value}`}>
      <T style={{ flex: 1 }}>{label}</T>
      <T secondary={!valueColor} color={valueColor}>
        {value}
      </T>
    </Row>
  );
}

export function ToggleRow({ label, value, onChange, subtitle, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; subtitle?: string; disabled?: boolean }) {
  const c = useTrioColors();
  return (
    <Row>
      <View style={{ flex: 1 }}>
        <T>{label}</T>
        {subtitle ? (
          <T style_="footnote" secondary>
            {subtitle}
          </T>
        ) : null}
      </View>
      <Switch value={value} disabled={disabled} onValueChange={onChange} trackColor={{ true: c.tabBar }} accessibilityLabel={label} />
    </Row>
  );
}

/** Menu-style picker row: tinted value with ⌃⌄ like SwiftUI `Picker(.menu)`. */
export function PickerRow<V extends string | number>({ label, value, options, onChange }: { label: string; value: V; options: readonly { value: V; label: string }[]; onChange: (v: V) => void }) {
  const c = useTrioColors();
  const current = options.find((o) => o.value === value)?.label ?? String(value);
  const open = () => {
    void Haptics.selectionAsync();
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: label, options: [...options.map((o) => o.label), 'Cancel'], cancelButtonIndex: options.length }, (i) => {
        if (i < options.length) onChange(options[i]!.value);
      });
    } else {
      Alert.alert(label, undefined, [...options.map((o) => ({ text: o.label, onPress: () => onChange(o.value) })), { text: 'Cancel', style: 'cancel' as const }]);
    }
  };
  return (
    <Row onPress={open} accessibilityLabel={`${label}, ${current}`}>
      <T style={{ flex: 1 }}>{label}</T>
      <T color={c.tabBar}>{current}</T>
      <SymbolView name="chevron.up.chevron.down" size={13} tintColor={c.tabBar} weight="semibold" />
    </Row>
  );
}

/** Right-aligned numeric/text entry with unit ("Carbs   0 g"). */
export function InputRow({
  label,
  value,
  onChangeText,
  unit,
  placeholder = '0',
  keyboardType = 'decimal-pad',
  icon,
  valueColor,
  maxLength,
}: {
  label?: string;
  value: string;
  onChangeText: (t: string) => void;
  unit?: string;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  icon?: SFSymbol;
  valueColor?: string;
  maxLength?: number;
}) {
  const c = useTrioColors();
  return (
    <Row>
      {icon ? <SymbolView name={icon} size={22} tintColor={c.primary} /> : null}
      {label ? <T style={{ flex: 1 }}>{label}</T> : <View style={{ flex: 1 }} />}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.tertiary}
        keyboardType={keyboardType}
        maxLength={maxLength}
        selectionColor={c.tabBar}
        style={[styles.input, { color: valueColor ?? c.primary }]}
        accessibilityLabel={label}
      />
      {unit ? <T secondary>{unit}</T> : null}
    </Row>
  );
}

export function CheckboxRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const c = useTrioColors();
  return (
    <Row onPress={() => onChange(!value)} accessibilityLabel={label}>
      <T style={{ flex: 1 }}>{label}</T>
      <SymbolView name={value ? 'checkmark.square.fill' : 'square'} size={26} tintColor={value ? c.tabBar : c.secondary} />
    </Row>
  );
}

export function RadioRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const c = useTrioColors();
  return (
    <Row onPress={onPress} accessibilityLabel={label}>
      <SymbolView name={selected ? 'checkmark.circle.fill' : 'circle'} size={24} tintColor={selected ? c.accent : c.secondary} />
      <T style={{ flex: 1 }}>{label}</T>
    </Row>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  header: { marginLeft: 20, marginTop: 8 },
  footer: { marginHorizontal: 20 },
  card: { borderRadius: 26, borderCurve: 'continuous', overflow: 'hidden' },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 20, marginRight: 20 },
  input: { minWidth: 60, textAlign: 'right', fontSize: 17, paddingVertical: 0 },
});
