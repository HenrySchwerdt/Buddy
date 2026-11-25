import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T, TrioBackground, useTrioColors } from '@/trio';
import { useSettings } from '@/runtime/settings-store';
import { parseHintLine, resolveCopy } from '../copy';

export interface Hint {
  readonly label: string;
  readonly lines: readonly string[];
}

const HintContext = createContext<(hint: Hint) => void>(() => undefined);

/** Opens Trio's "Help" sheet (SettingInputHintView) for a setting. */
export const useShowHint = () => useContext(HintContext);

/** Hosts the Help sheet for every SettingInputSection below it. */
export function HintSheetProvider({ children }: PropsWithChildren) {
  const [hint, setHint] = useState<Hint | null>(null);
  const show = useCallback((h: Hint) => setHint(h), []);
  return (
    <HintContext.Provider value={show}>
      {children}
      <Modal visible={hint !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setHint(null)}>
        {hint ? <HintSheet hint={hint} onClose={() => setHint(null)} /> : null}
      </Modal>
    </HintContext.Provider>
  );
}

function HintSheet({ hint, onClose }: { hint: Hint; onClose: () => void }) {
  const c = useTrioColors();
  const units = useSettings((s) => s.units);
  const insets = useSafeAreaInsets();
  const lines = useMemo(() => hint.lines.map(parseHintLine), [hint.lines]);
  return (
    <View style={{ flex: 1 }}>
      <TrioBackground />
      <T style_="headline" align="center" style={styles.title} accessibilityRole="header">
        Help
      </T>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[styles.card, { backgroundColor: 'rgba(142,142,147,0.1)' }]}>
          <T style_="headline">{resolveCopy(hint.label, units)}</T>
          {lines.map((l, i) => (
            <T key={i} weight={l.style === 'plain' ? undefined : '600'} color={l.style === 'warning' ? c.orange : undefined}>
              {resolveCopy(l.text, units)}
            </T>
          ))}
        </View>
      </ScrollView>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        style={({ pressed }) => [styles.button, { backgroundColor: c.fill, marginBottom: insets.bottom + 16, opacity: pressed ? 0.7 : 1 }]}>
        <T weight="600" color={c.accent}>
          Got it!
        </T>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 20, marginBottom: 4 },
  card: { borderRadius: 12, padding: 16, gap: 10 },
  button: { marginHorizontal: 16, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
