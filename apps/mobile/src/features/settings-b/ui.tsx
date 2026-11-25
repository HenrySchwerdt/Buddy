import * as Haptics from 'expo-haptics';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Switch, View } from 'react-native';
import { Row, SheetScreen, T, useTrioColors } from '@/trio';

/** SwiftUI indigo (dark / light), used for the night-window moon. */
export const INDIGO = { dark: '#5E5CE6', light: '#5856D6' } as const;

/** SwiftUI `.buttonStyle(.bordered)` with `.font(.title3)`: tinted translucent capsule. */
export function BorderedButton({
  label,
  icon,
  onPress,
  disabled,
  loading,
  color,
  bold,
}: {
  label: string;
  icon?: SFSymbol;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  color?: string;
  bold?: boolean;
}) {
  const c = useTrioColors();
  const tint = disabled ? c.tertiary : (color ?? c.tabBar);
  return (
    <Pressable
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading }}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [styles.bordered, { backgroundColor: disabled ? c.fill : `${color ?? c.tabBar}40`, opacity: pressed ? 0.7 : 1 }]}>
      {loading ? <ActivityIndicator color={tint} /> : icon ? <SymbolView name={icon} size={22} tintColor={tint} /> : null}
      <T style_="title3" weight={bold ? '700' : '400'} color={tint}>
        {label}
      </T>
    </Pressable>
  );
}

/** Centred bordered button inside a padded list row (`VStack { Button }.padding(.vertical)`). */
export function ButtonCard({ children }: { children: ReactNode }) {
  return <View style={styles.buttonCard}>{children}</View>;
}

/** Trio's mini hint + "?" button underneath a setting (SettingInputSection.hintSection). */
export function MiniHint({ text, onHelp, color, label }: { text: string; onHelp: () => void; color?: string; label: string }) {
  const c = useTrioColors();
  return (
    <View style={styles.hintRow}>
      <T style_="footnote" color={color ?? c.secondary} style={{ flex: 1 }}>
        {text}
      </T>
      <Pressable onPress={onHelp} hitSlop={10} accessibilityRole="button" accessibilityLabel={`More information about ${label}`}>
        <SymbolView name="questionmark.circle" size={20} tintColor={c.tabBar} />
      </Pressable>
    </View>
  );
}

export interface HintContent {
  readonly label: string;
  readonly body: ReactNode;
}

/** SettingInputHintView: "Help" sheet with term + definition and a "Got it!" button. */
export function HintSheet({ hint, onClose }: { hint: HintContent | null; onClose: () => void }) {
  const c = useTrioColors();
  return (
    <Modal visible={hint !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SheetScreen
        title="Help"
        footer={
          <Pressable onPress={onClose} accessibilityRole="button" style={({ pressed }) => [styles.gotIt, { backgroundColor: `${c.tabBar}40`, opacity: pressed ? 0.7 : 1 }]}>
            <T weight="700" color={c.tabBar}>
              Got it!
            </T>
          </Pressable>
        }>
        {hint ? (
          <View style={[styles.definition, { backgroundColor: 'rgba(142,142,147,0.1)' }]}>
            <T style_="headline">{hint.label}</T>
            {typeof hint.body === 'string' ? <T>{hint.body}</T> : hint.body}
          </View>
        ) : null}
      </SheetScreen>
    </Modal>
  );
}

/** Paragraph stack used in verbose hints (`VStack(alignment: .leading, spacing: 10)`). */
export function HintParagraphs({ lines, boldFirst }: { lines: readonly string[]; boldFirst?: boolean }) {
  return (
    <View style={{ gap: 10 }}>
      {lines.map((l, i) => (
        <T key={i} weight={boldFirst && i === 0 ? '700' : undefined}>
          {l}
        </T>
      ))}
    </View>
  );
}

/** SettingInputSection(type: .boolean): toggle with mini hint and "?" in one row. */
export function ToggleWithHint({
  label,
  value,
  onChange,
  miniHint,
  onHelp,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  miniHint: string;
  onHelp: () => void;
  disabled?: boolean;
}) {
  const c = useTrioColors();
  return (
    <View style={styles.settingCard}>
      <View style={styles.toggleLine}>
        <T style={{ flex: 1 }} color={disabled ? c.secondary : undefined}>
          {label}
        </T>
        <Switch value={value} disabled={disabled} onValueChange={onChange} trackColor={{ true: c.tabBar }} accessibilityLabel={label} />
      </View>
      <MiniHint text={miniHint} onHelp={onHelp} label={label} />
    </View>
  );
}

/** A list row for something Buddy does not offer yet: dimmed, not tappable, keeps Trio's order. */
export function UnavailableRow({ label, note = 'Not available yet' }: { label: string; note?: string }) {
  const c = useTrioColors();
  return (
    <Row accessibilityLabel={`${label}, ${note}`}>
      <View style={{ flex: 1 }}>
        <T color={c.secondary}>{label}</T>
        <T style_="footnote" color={c.tertiary}>
          {note}
        </T>
      </View>
      <SymbolView name="chevron.right" size={14} tintColor={c.fill} weight="semibold" />
    </Row>
  );
}

/** Plain-text navigation row tinted like `.foregroundStyle(Color.accentColor)`. */
export function TintedNavRow({ label, onPress, color }: { label: string; onPress: () => void; color?: string }) {
  const c = useTrioColors();
  return (
    <Row onPress={onPress} accessibilityLabel={label}>
      <T style={{ flex: 1 }} color={color ?? c.tabBar}>
        {label}
      </T>
      <SymbolView name="chevron.right" size={14} tintColor={c.tertiary} weight="semibold" />
    </Row>
  );
}

/** AlarmWindowIcon: sun (day), moon (night) or both overlapped, fixed width. */
export function WindowIcon({ option }: { option: 'always' | 'day' | 'night' }) {
  const c = useTrioColors();
  const indigo = c.dark ? INDIGO.dark : INDIGO.light;
  return (
    <View style={styles.windowIcon} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {option !== 'night' ? <SymbolView name="sun.max.fill" size={20} tintColor={c.orange} /> : null}
      {option !== 'day' ? <SymbolView name="moon.stars.fill" size={20} tintColor={indigo} style={option === 'always' ? { marginLeft: -8 } : undefined} /> : null}
    </View>
  );
}

/** Simple local state for one help sheet per screen. */
export function useHint() {
  const [hint, setHint] = useState<HintContent | null>(null);
  return { hint, show: setHint, close: () => setHint(null) } as const;
}

const styles = StyleSheet.create({
  bordered: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderCurve: 'continuous',
  },
  buttonCard: { paddingHorizontal: 20, paddingVertical: 24, alignItems: 'center' },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16 },
  settingCard: { paddingHorizontal: 20, paddingTop: 16 },
  toggleLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  gotIt: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  definition: { borderRadius: 16, padding: 16, gap: 8 },
  windowIcon: { width: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
