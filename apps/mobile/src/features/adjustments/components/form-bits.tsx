import * as Haptics from 'expo-haptics';
import { SymbolView } from '@/trio/symbol';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Row, T, TrioBackground, useTrioColors } from '@/trio';

/** `HStack { Text(label); Spacer(); Text(value).foregroundColor(open ? .accentColor : .primary).onTapGesture }`. */
export function TapValueRow({ label, value, open, onPress, dim }: { label: string; value: string; open: boolean; onPress: () => void; dim?: boolean }) {
  const c = useTrioColors();
  return (
    <Row onPress={onPress} accessibilityLabel={`${label}, ${value}`}>
      <T style={{ flex: 1 }}>{label}</T>
      <T color={open ? c.accent : dim ? c.secondary : c.primary}>{value}</T>
    </Row>
  );
}

/** Two tappable values in one row: "From 22:00 | To 06:00", "SMB 30 min | UAM 30 min". */
export function PairRow({ left, right, open, onPress }: { left: [string, string]; right: [string, string]; open: boolean; onPress: () => void }) {
  const c = useTrioColors();
  const color = open ? c.accent : c.primary;
  return (
    <Row onPress={onPress} accessibilityLabel={`${left.join(' ')}, ${right.join(' ')}`}>
      <T>{left[0]}</T>
      <T color={color} style={styles.pairValue}>
        {left[1]}
      </T>
      <View style={[styles.divider, { backgroundColor: c.separator }]} />
      <T>{right[0]}</T>
      <T color={color} style={styles.pairValue}>
        {right[1]}
      </T>
    </Row>
  );
}

/** Trio `RadioButton` (largecircle.fill.circle / circle). */
export function RadioStep({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const c = useTrioColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }} style={styles.radio}>
      <SymbolView name={selected ? 'largecircle.fill.circle' : 'circle'} size={20} tintColor={c.accent} />
      <T>{label}</T>
    </Pressable>
  );
}

/** `HStack { Text("Name"); TextField("(Optional)").multilineTextAlignment(.trailing) }`. */
export function NameRow({ value, onChange, placeholder = '(Optional)' }: { value: string; onChange: (t: string) => void; placeholder?: string }) {
  const c = useTrioColors();
  return (
    <Row>
      <T>Name</T>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.tertiary}
        selectionColor={c.tabBar}
        returnKeyType="done"
        style={[styles.name, { color: c.primary }]}
        accessibilityLabel="Name"
      />
    </Row>
  );
}

/** Orange validation message in the save section's header. */
export function ErrorHeader({ message }: { message: string | null }) {
  const c = useTrioColors();
  if (!message) return null;
  return (
    <T style_="headline" color={c.dark ? c.orange : c.accent} align="center" style={{ marginTop: 6 }}>
      {message}
    </T>
  );
}

/** A `Button` used as a whole List row with `.listRowBackground(...)` ("Start Override", "Save as Preset"). */
export function ListButton({ label, onPress, disabled, background }: { label: string; onPress: () => void; disabled?: boolean; background: string }) {
  const c = useTrioColors();
  const bg = disabled ? (c.dark ? '#3A3A3C' : '#D1D1D6') : background;
  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.listButton, { backgroundColor: bg, opacity: pressed ? 0.8 : 1 }]}>
      <T color={disabled ? c.secondary : '#FFFFFF'}>{label}</T>
    </Pressable>
  );
}

/** A List row with its own background (Trio's "… is running" row in purple / loop green). */
export function TintedRow({ children, color, onPress, hint }: { children: ReactNode; color: string; onPress?: () => void; hint?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityHint={hint} style={({ pressed }) => [styles.tinted, { backgroundColor: color, opacity: pressed ? 0.85 : 1 }]}>
      {children}
    </Pressable>
  );
}

/** Trio's help sheets: inline "Help" title, gray text card(s), bordered "Got it!" button. */
export function HelpSheet({ visible, onClose, sections }: { visible: boolean; onClose: () => void; sections: readonly { header?: string; paragraphs: readonly (string | readonly string[])[] }[] }) {
  const c = useTrioColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} presentationStyle="pageSheet" animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1 }}>
        <TrioBackground />
        <T style_="headline" align="center" style={{ marginTop: 20, marginBottom: 12 }}>
          Help
        </T>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 32, gap: 16, paddingBottom: 16 }}>
          {sections.map((s, i) => (
            <View key={i} style={{ gap: 8 }}>
              {s.header ? (
                <T style_="footnote" secondary style={{ textTransform: 'uppercase', marginLeft: 16 }}>
                  {s.header}
                </T>
              ) : null}
              <View style={[styles.helpCard, { backgroundColor: 'rgba(142,142,147,0.1)' }]}>
                {s.paragraphs.map((p, j) =>
                  typeof p === 'string' ? (
                    <T key={j}>{p}</T>
                  ) : (
                    <View key={j}>
                      {p.map((line) => (
                        <T key={line}>{line}</T>
                      ))}
                    </View>
                  ),
                )}
              </View>
            </View>
          ))}
        </ScrollView>
        <Pressable onPress={onClose} accessibilityRole="button" style={({ pressed }) => [styles.gotIt, { backgroundColor: c.fill, marginBottom: insets.bottom + 16, opacity: pressed ? 0.7 : 1 }]}>
          <T style_="headline" color={c.tabBar}>
            Got it!
          </T>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  pairValue: { flex: 1, textAlign: 'center' },
  divider: { width: StyleSheet.hairlineWidth * 2, height: 20 },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  name: { flex: 1, textAlign: 'right', fontSize: 17, paddingVertical: 0 },
  listButton: { minHeight: 52, borderRadius: 26, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  tinted: { minHeight: 52, borderRadius: 26, borderCurve: 'continuous', flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  helpCard: { borderRadius: 26, borderCurve: 'continuous', padding: 20, gap: 10 },
  gotIt: { marginHorizontal: 32, marginTop: 16, minHeight: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
});
