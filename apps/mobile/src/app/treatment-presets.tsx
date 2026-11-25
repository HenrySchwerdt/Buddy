import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from '@/trio/symbol';
import { useMemo, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { choose as chooseFromList } from '@/trio/choice-dialog';
import { CapsuleButton, Row, Section, T, TrioScreen, useTrioColors } from '@/trio';
import { AddPresetSheet } from '@/features/treatment/add-preset-sheet';
import { useTreatmentDraft } from '@/features/treatment/draft-store';
import { sortedPresets, useMealPresets, type MealPreset } from '@/features/treatment/presets-store';
import { SYSTEM_BLUE } from '@/features/treatment/rows';
import { useTreatmentSettings } from '@/features/treatment/settings-store';
import { TreatmentButton } from '@/features/treatment/treatment-button';

interface Totals {
  readonly carbs: number;
  readonly fat: number;
  readonly protein: number;
}
const ZERO: Totals = { carbs: 0, fat: 0, protein: 0 };
const fmt = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v);

/** Port of Trio's `MealPresetView` ("Meal Presets"). */
export default function TreatmentPresetsSheet() {
  const c = useTrioColors();
  const blue = Platform.OS === 'android' ? c.accent : SYSTEM_BLUE;
  const { presets: stored, add, remove } = useMealPresets();
  const useFPU = useTreatmentSettings((s) => s.useFPUconversion);
  const presets = useMemo(() => sortedPresets(stored), [stored]);
  const [selection, setSelection] = useState<MealPreset | null>(null);
  const [summation, setSummation] = useState<readonly string[]>([]);
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [adding, setAdding] = useState(false);

  const addServing = (p: MealPreset) => {
    setTotals((t) => ({ carbs: t.carbs + p.carbs, fat: useFPU ? t.fat + p.fat : t.fat, protein: useFPU ? t.protein + p.protein : t.protein }));
    setSummation((s) => [...s, p.dish]);
  };

  const removeServing = () => {
    if (!selection) return;
    const next: Totals = {
      carbs: totals.carbs !== 0 ? totals.carbs - selection.carbs : 0,
      fat: useFPU && totals.fat !== 0 && totals.fat - selection.fat >= 0 ? totals.fat - selection.fat : useFPU ? 0 : totals.fat,
      protein: useFPU && totals.protein !== 0 && totals.protein - selection.protein >= 0 ? totals.protein - selection.protein : useFPU ? 0 : totals.protein,
    };
    const idx = summation.indexOf(selection.dish);
    const nextSummation = idx >= 0 ? summation.filter((_, i) => i !== idx) : summation;
    setTotals(next);
    setSummation(next.carbs === 0 && next.fat === 0 && next.protein === 0 ? [] : nextSummation);
  };

  const choose = () => {
    const options = ['Saved Food', ...presets.map((p) => p.dish)];
    const pick = (i: number) => {
      const p = i === 0 ? null : presets[i - 1]!;
      setSelection(p);
      if (p) addServing(p);
    };
    void Haptics.selectionAsync();
    void chooseFromList({ title: 'Preset', items: options.map((label) => ({ label })) }).then((i) => {
      if (i !== null) pick(i);
    });
  };

  const confirmDelete = () => {
    if (!selection) return;
    Alert.alert(`Delete preset '${selection.dish}'?`, undefined, [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes',
        style: 'destructive',
        onPress: () => {
          const count = summation.filter((d) => d === selection.dish).length;
          setSummation((s) => s.filter((d) => d !== selection.dish));
          setTotals((t) => ({ carbs: t.carbs - selection.carbs * count, fat: t.fat - selection.fat * count, protein: t.protein - selection.protein * count }));
          remove(selection.id);
          setSelection(null);
        },
      },
    ]);
  };

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    summation.forEach((d) => m.set(d, (m.get(d) ?? 0) + 1));
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [summation]);
  const noPresetChosen = selection === null || summation.length === 0;
  const canRemove = selection !== null && (summation.includes(selection.dish) || selection.dish === '');

  return (
    <View style={{ flex: 1 }}>
      <TrioScreen
        title="Meal Presets"
        tabBar={false}
        leading={<CapsuleButton label="Close" color={c.primary} onPress={() => router.back()} />}
        trailing={<CapsuleButton label="New Preset" icon="plus" color={c.primary} onPress={() => setAdding(true)} />}>
        <Section>
          <Row>
            {selection ? (
              <Pressable onPress={removeServing} disabled={!canRemove} accessibilityRole="button" accessibilityLabel="Remove one serving" hitSlop={6}>
                <SymbolView name="minus.circle.fill" size={24} tintColor={canRemove ? blue : c.tertiary} />
              </Pressable>
            ) : null}
            <Pressable onPress={choose} accessibilityRole="button" accessibilityLabel={`Preset, ${selection?.dish ?? 'Saved Food'}`} style={styles.picker}>
              <T color={c.tabBar}>{selection?.dish ?? 'Saved Food'}</T>
              {Platform.OS === 'android' ? <SymbolView name={{ android: 'arrow_drop_down' }} size={24} tintColor={c.tabBar} /> : <SymbolView name="chevron.up.chevron.down" size={13} tintColor={c.tabBar} weight="semibold" />}
            </Pressable>
            {selection ? (
              <Pressable onPress={() => addServing(selection)} accessibilityRole="button" accessibilityLabel="Add one serving" hitSlop={6}>
                <SymbolView name="plus.circle.fill" size={24} tintColor={blue} />
              </Pressable>
            ) : null}
          </Row>
          <Row style={{ justifyContent: 'center' }}>
            <Pressable onPress={confirmDelete} disabled={!selection} accessibilityRole="button">
              <T color={selection ? c.orange : c.tertiary}>Delete Preset</T>
            </Pressable>
          </Row>
        </Section>

        {summation.length > 0 ? (
          <Section header="Summary">
            <View style={styles.summary}>
              {counts.map(([dish, n]) => (
                <View key={dish} style={{ flexDirection: 'row', gap: 8 }}>
                  <T color={blue}>{`${n} x`}</T>
                  <T>{dish}</T>
                </View>
              ))}
              <Macro label="Carbs: " value={totals.carbs} />
              {useFPU ? <Macro label="Protein: " value={totals.protein} /> : null}
              {useFPU ? <Macro label="Fat: " value={totals.fat} /> : null}
            </View>
          </Section>
        ) : null}

        <TreatmentButton
          label="Add to Treatments"
          disabled={noPresetChosen}
          limitExceeded={false}
          onPress={() => {
            useTreatmentDraft.getState().addMacros(totals.carbs, totals.fat, totals.protein);
            router.back();
          }}
        />
      </TrioScreen>
      <AddPresetSheet
        visible={adding}
        showFatProtein={useFPU}
        onCancel={() => setAdding(false)}
        onSave={(p) => {
          add(p);
          setAdding(false);
        }}
      />
    </View>
  );
}

function Macro({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.macro}>
      <T style_="footnote" secondary>
        {label}
      </T>
      <T style_="footnote">
        {fmt(value)}
        <T style_="footnote" secondary>
          {' g'}
        </T>
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  summary: { paddingHorizontal: 20, paddingVertical: 12, gap: 6 },
  macro: { flexDirection: 'row', justifyContent: 'space-between' },
});
