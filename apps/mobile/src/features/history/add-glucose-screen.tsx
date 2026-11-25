import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { CapsuleButton, InputRow, Section, SheetScreen, T, useTrioColors } from '@/trio';
import { useSettings } from '@/runtime/settings-store';
import { addManualGlucose, manualGlucoseMgdl, parseGlucoseInput, useHistoryMode } from './actions';

/** HistoryRootView+AddGlucose: manual (fingerstick) glucose entry. */
export function AddGlucoseScreen() {
  const c = useTrioColors();
  const units = useSettings((s) => s.units);
  const setMode = useHistoryMode((s) => s.setMode);
  const [text, setText] = useState('');
  const mgdl = manualGlucoseMgdl(parseGlucoseInput(text), units);
  const disabled = mgdl === null;

  const onChange = (t: string) => {
    // NumberFormatter: mg/dL max 3 integer digits, no decimals; mmol/L max 2 integer digits, 1 decimal.
    const pattern = units === 'mg/dL' ? /^\d{0,3}$/ : /^\d{0,2}([.,]\d?)?$/;
    if (pattern.test(t)) setText(t);
  };

  return (
    <SheetScreen title="Add Glucose" leading={<CapsuleButton label="Close" color={c.tabBar} onPress={() => router.back()} />}>
      <Section>
        <InputRow label="New Glucose" value={text} onChangeText={onChange} placeholder=" ... " unit={units} keyboardType={units === 'mg/dL' ? 'number-pad' : 'decimal-pad'} />
      </Section>
      <Pressable
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        onPress={() => {
          if (mgdl === null) return;
          addManualGlucose(mgdl);
          setMode('glucose');
          router.back();
        }}
        style={({ pressed }) => [styles.save, { backgroundColor: disabled ? (c.dark ? '#3A3A3C' : '#D1D1D6') : c.accent, opacity: pressed ? 0.85 : 1 }]}>
        <T color="#FFFFFF">Save</T>
      </Pressable>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  save: { minHeight: 52, borderRadius: 26, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
});
