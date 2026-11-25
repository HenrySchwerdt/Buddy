import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Share, View } from 'react-native';
import { AVAILABLE_CATEGORIES, buildSettingsExport, EXPORT_CATEGORIES, UNAVAILABLE_CATEGORIES, type ExportCategory } from '@/features/settings-b/export';
import { now } from '@/runtime/runtime';
import { useSettings } from '@/runtime/settings-store';
import { Row, Section, T, TrioScreen, useTrioColors } from '@/trio';

/** Trio SettingsExport.RootView: pick categories, share the JSON via the iOS share sheet. */
export default function ExportSettingsScreen() {
  const c = useTrioColors();
  const [selected, setSelected] = useState<ReadonlySet<ExportCategory>>(() => new Set(AVAILABLE_CATEGORIES));
  const [exporting, setExporting] = useState(false);
  const allSelected = AVAILABLE_CATEGORIES.every((cat) => selected.has(cat));
  const checkboxBlue = c.accent;

  const toggle = (cat: ExportCategory) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  const runExport = async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setExporting(true);
    try {
      const json = buildSettingsExport(useSettings.getState(), selected, {
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        exportedAt: new Date(now()).toISOString(),
      });
      if (json.length <= 2) throw new Error('Export file is empty (0 bytes)');
      await Share.share({ message: json, title: 'Buddy Settings' });
    } catch (e) {
      Alert.alert('Export Error', e instanceof Error ? e.message : String(e), [{ text: 'OK', style: 'cancel' }]);
    } finally {
      setExporting(false);
    }
  };

  const disabled = selected.size === 0 || exporting;

  return (
    <TrioScreen back title="Export Settings">
      <Section header="Export Categories">
        <Row onPress={() => setSelected(allSelected ? new Set() : new Set(AVAILABLE_CATEGORIES))} accessibilityLabel={allSelected ? 'Deselect All' : 'Select All'}>
          <SymbolView name={allSelected ? 'checkmark.square.fill' : 'square'} size={22} tintColor={allSelected ? checkboxBlue : c.secondary} />
          <T weight="700" style={{ flex: 1 }}>
            {allSelected ? 'Deselect All' : 'Select All'}
          </T>
        </Row>
        {EXPORT_CATEGORIES.map((cat) => {
          if (UNAVAILABLE_CATEGORIES.has(cat)) {
            return (
              <Row key={cat} accessibilityLabel={`${cat}, not available yet`}>
                <SymbolView name="square" size={22} tintColor={c.tertiary} />
                <View style={{ flex: 1 }}>
                  <T color={c.secondary}>{cat}</T>
                  <T style_="footnote" color={c.tertiary}>
                    Not available yet
                  </T>
                </View>
              </Row>
            );
          }
          const on = selected.has(cat);
          return (
            <Row key={cat} onPress={() => toggle(cat)} accessibilityLabel={`${cat}, ${on ? 'Selected' : 'Not selected'}`}>
              <SymbolView name={on ? 'checkmark.square.fill' : 'square'} size={22} tintColor={on ? checkboxBlue : c.secondary} />
              <T style={{ flex: 1 }}>{cat}</T>
            </Row>
          );
        })}
      </Section>

      <Pressable
        disabled={disabled}
        onPress={() => void runExport()}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        style={({ pressed }) => ({
          minHeight: 52,
          borderRadius: 26,
          borderCurve: 'continuous',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 10,
          backgroundColor: selected.size === 0 ? (c.dark ? '#3A3A3C' : '#D1D1D6') : c.accent,
          opacity: pressed ? 0.85 : 1,
        })}>
        {exporting ? <ActivityIndicator color="#fff" /> : null}
        <T color="#FFFFFF">{exporting ? 'Exporting...' : 'Export Settings'}</T>
      </Pressable>
    </TrioScreen>
  );
}
